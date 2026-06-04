import { supabase } from './supabaseClient';

function getIceServers() {
  if (typeof window !== 'undefined' && window.location) {
    const hn = window.location.hostname;
    const isLocal = hn === 'localhost' || 
                    hn === '127.0.0.1' || 
                    hn === '[::1]' ||
                    hn.startsWith('192.168.') || 
                    hn.startsWith('10.') || 
                    hn.startsWith('172.16.') || 
                    hn.startsWith('172.17.') || 
                    hn.startsWith('172.18.') || 
                    hn.startsWith('172.19.') || 
                    hn.startsWith('172.20.') || 
                    hn.startsWith('172.21.') || 
                    hn.startsWith('172.22.') || 
                    hn.startsWith('172.23.') || 
                    hn.startsWith('172.24.') || 
                    hn.startsWith('172.25.') || 
                    hn.startsWith('172.26.') || 
                    hn.startsWith('172.27.') || 
                    hn.startsWith('172.28.') || 
                    hn.startsWith('172.29.') || 
                    hn.startsWith('172.30.') || 
                    hn.startsWith('172.31.') || 
                    hn.endsWith('.local');
    if (isLocal) {
      return [];
    }
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

export class WebRTCSession {
  constructor(sessionId, userId, role, onStream, onStateChange, onStreamStateChange) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.role = role;
    this.onStream = onStream;
    this.onStateChange = onStateChange; // (state: 'connecting' | 'connected' | 'failed' | 'simulated')
    this.onStreamStateChange = onStreamStateChange; // callback when teacher stream state changes
    
    this.pcs = {}; // peer connections (teacher maps studentId -> pc)
    this.iceCandidatesQueue = {}; // queues candidates before remote description is set
    this.localStream = null;
    this.channel = null;

    // Track stream options to replay them to late-joining students
    this.lastVideoEnabled = true;
    this.lastAudioEnabled = true;
    this.lastStreamSource = 'camera';
    
    this.setupSignaling();
  }

  // Setup Supabase Broadcast Channel for WebRTC signaling
  setupSignaling() {
    const channelName = `webrtc-session-${this.sessionId}`;
    this.channel = supabase.channel(channelName);
    
    this.channel.on('broadcast', { event: 'signal' }, async ({ payload }) => {
      const { type, from, to, data } = payload;
      
      // Ignore signals not directed to us
      if (to !== this.userId && to !== 'all') return;
      // Ignore signals from ourselves
      if (from === this.userId) return;

      try {
        if (type === 'student-joined' && this.role === 'teacher') {
          await this.initiatePeerConnection(from);
          // Broadcast current stream state specifically so late joiner receives it
          this.broadcastStreamState({
            videoEnabled: this.lastVideoEnabled,
            audioEnabled: this.lastAudioEnabled,
            streamSource: this.lastStreamSource
          });
        } else if (type === 'offer' && this.role === 'student') {
          await this.handleOffer(from, data);
        } else if (type === 'answer' && this.role === 'teacher') {
          await this.handleAnswer(from, data);
        } else if (type === 'ice-candidate') {
          await this.handleIceCandidate(from, data);
        } else if (type === 'teacher-joined' && this.role === 'student') {
          // Self-healing: if student receives a teacher-joined message, request connection
          this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'student-joined', from: this.userId, to: 'all' }
          });
          this.updateState('connecting');
          
          if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
          this.fallbackTimeout = setTimeout(() => {
            if (Object.keys(this.pcs).length === 0) {
              this.updateState('simulated');
            }
          }, 15000);
        } else if (type === 'stream-state') {
          if (this.onStreamStateChange) {
            this.onStreamStateChange(data);
          }
          // Self-healing: if student is currently simulated or has no peer connection, reconnect
          if (this.role === 'student' && Object.keys(this.pcs).length === 0) {
            this.channel.send({
              type: 'broadcast',
              event: 'signal',
              payload: { type: 'student-joined', from: this.userId, to: 'all' }
            });
            this.updateState('connecting');
            
            if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
            this.fallbackTimeout = setTimeout(() => {
              if (Object.keys(this.pcs).length === 0) {
                this.updateState('simulated');
              }
            }, 15000);
          }
        }
      } catch (err) {
        console.warn('WebRTC signal processing error: ', err);
        this.updateState('simulated');
      }
    });

    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (this.role === 'student') {
          // Tell teacher we joined
          this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'student-joined', from: this.userId, to: 'all' }
          });
          this.updateState('connecting');
          
          // Set a timeout to switch to simulated if peer connection takes too long
          this.fallbackTimeout = setTimeout(() => {
            if (Object.keys(this.pcs).length === 0) {
              this.updateState('simulated');
            }
          }, 15000);
        } else if (this.role === 'teacher') {
          // Tell students teacher is online
          this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'teacher-joined', from: this.userId, to: 'all' }
          });
        }
      }
    });
  }

  updateState(state) {
    if (this.onStateChange) this.onStateChange(state);
  }

  // Capture user webcam/mic or screen media
  async startLocalStream(type = 'camera') {
    this.streamPromise = (async () => {
      try {
        let videoTrack = null;
        let audioTrack = null;

        // 1. Acquire new video track first
        if (type === 'screen') {
          const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: true
          });
          videoTrack = screenStream.getVideoTracks()[0];
          
          if (videoTrack) {
            // Listen to browser's native "Stop Sharing" button
            videoTrack.addEventListener('ended', () => {
              this.startLocalStream('camera');
              this.broadcastStreamState({
                videoEnabled: this.lastVideoEnabled,
                audioEnabled: this.lastAudioEnabled,
                streamSource: 'camera'
              });
            });
          }
        } else {
          const cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
          });
          videoTrack = cameraStream.getVideoTracks()[0];
        }

        // 2. Reuse or acquire audio track (keep microphone active)
        const existingAudioTrack = this.localStream?.getAudioTracks()[0];
        if (existingAudioTrack && existingAudioTrack.readyState === 'live') {
          audioTrack = existingAudioTrack;
        } else {
          try {
            const audioStream = await navigator.mediaDevices.getUserMedia({
              audio: true
            });
            audioTrack = audioStream.getAudioTracks()[0];
          } catch (audioErr) {
            console.warn("Could not acquire microphone track:", audioErr);
          }
        }

        // 3. Stop old tracks only if we have replaced them
        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(track => {
            if (track !== videoTrack) track.stop();
          });
          this.localStream.getAudioTracks().forEach(track => {
            if (track !== audioTrack) track.stop();
          });
        }

        // 4. Combine into new MediaStream
        const tracks = [];
        if (videoTrack) {
          videoTrack.enabled = this.lastVideoEnabled;
          tracks.push(videoTrack);
        }
        if (audioTrack) {
          audioTrack.enabled = this.lastAudioEnabled;
          tracks.push(audioTrack);
        }
        this.localStream = new MediaStream(tracks);

        // 5. Replace tracks in active peer connections
        Object.keys(this.pcs).forEach(peerId => {
          const pc = this.pcs[peerId];
          const transceivers = pc.getTransceivers();
          const videoTransceiver = transceivers.find(t => t.receiver.track.kind === 'video');
          const audioTransceiver = transceivers.find(t => t.receiver.track.kind === 'audio');
          
          if (videoTransceiver && videoTrack) {
            videoTransceiver.sender.replaceTrack(videoTrack).catch(err => {
              console.warn("Could not replace video track:", err);
            });
          }
          
          if (audioTransceiver && audioTrack) {
            audioTransceiver.sender.replaceTrack(audioTrack).catch(err => {
              console.warn("Could not replace audio track:", err);
            });
          }
        });
        
        return this.localStream;
      } catch (err) {
        console.warn("Failed to acquire media stream:", err);
        if (!this.localStream) {
          this.updateState('simulated');
        }
        return this.localStream;
      }
    })();
    return this.streamPromise;
  }

  // Teacher initiates the connection to a student
  async initiatePeerConnection(studentId) {
    if (this.pcs[studentId]) {
      try {
        this.pcs[studentId].close();
      } catch (e) {}
    }

    if (this.streamPromise) {
      await this.streamPromise;
    }

    this.updateState('connecting');
    const pc = new RTCPeerConnection({
      iceServers: getIceServers()
    });

    this.pcs[studentId] = pc;

    // Add transceivers with local tracks directly if available
    const videoTrack = this.localStream?.getVideoTracks()[0];
    const audioTrack = this.localStream?.getAudioTracks()[0];

    if (videoTrack) {
      pc.addTransceiver(videoTrack, { direction: 'sendrecv' });
    } else {
      pc.addTransceiver('video', { direction: 'sendrecv' });
    }

    if (audioTrack) {
      pc.addTransceiver(audioTrack, { direction: 'sendrecv' });
    } else {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: { type: 'ice-candidate', from: this.userId, to: studentId, data: event.candidate.toJSON() }
        });
      }
    };

    pc.ontrack = (event) => {
      if (!pc.remoteStream) {
        pc.remoteStream = new MediaStream();
      }
      if (!pc.remoteStream.getTracks().find(t => t.id === event.track.id)) {
        pc.remoteStream.addTrack(event.track);
      }
      if (this.onStream) {
        this.onStream(pc.remoteStream, studentId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.updateState('connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        this.updateState('simulated');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { type: 'offer', from: this.userId, to: studentId, data: { type: offer.type, sdp: offer.sdp } }
    });
  }

  // Student responds to Teacher's offer
  async handleOffer(teacherId, offer) {
    if (this.pcs[teacherId]) {
      try {
        this.pcs[teacherId].close();
      } catch (e) {}
    }

    if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
    this.updateState('connecting');
    
    const pc = new RTCPeerConnection({
      iceServers: getIceServers()
    });
    
    this.pcs[teacherId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: { type: 'ice-candidate', from: this.userId, to: teacherId, data: event.candidate.toJSON() }
        });
      }
    };

    pc.ontrack = (event) => {
      if (!pc.remoteStream) {
        pc.remoteStream = new MediaStream();
      }
      if (!pc.remoteStream.getTracks().find(t => t.id === event.track.id)) {
        pc.remoteStream.addTrack(event.track);
      }
      if (this.onStream) {
        this.onStream(pc.remoteStream, teacherId);
      }
      this.updateState('connected');
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.updateState('connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        this.updateState('simulated');
      }
    };

    // 1. Set remote description FIRST to create transceivers automatically from the offer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.processQueuedCandidates(teacherId);

    // 2. Set local tracks on the automatically created transceivers
    const transceivers = pc.getTransceivers();
    const videoTransceiver = transceivers.find(t => t.receiver.track.kind === 'video' || t.sender.track?.kind === 'video');
    const audioTransceiver = transceivers.find(t => t.receiver.track.kind === 'audio' || t.sender.track?.kind === 'audio');

    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      const audioTrack = this.localStream.getAudioTracks()[0];
      
      if (videoTransceiver && videoTrack) {
        await videoTransceiver.sender.replaceTrack(videoTrack);
      }
      if (audioTransceiver && audioTrack) {
        await audioTransceiver.sender.replaceTrack(audioTrack);
      }
    }

    // Ensure transceiver direction is sendrecv so student sends media back
    if (videoTransceiver) videoTransceiver.direction = 'sendrecv';
    if (audioTransceiver) audioTransceiver.direction = 'sendrecv';
    
    // 3. Create and set local answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { type: 'answer', from: this.userId, to: teacherId, data: { type: answer.type, sdp: answer.sdp } }
    });
  }

  // Teacher processes Student's answer
  async handleAnswer(studentId, answer) {
    const pc = this.pcs[studentId];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.processQueuedCandidates(studentId);
    }
  }

  // Handle ICE candidates exchange
  async handleIceCandidate(fromId, candidate) {
    const pc = this.pcs[fromId];
    if (pc && pc.remoteDescription) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn("Error adding ICE candidate directly:", e);
      }
    } else {
      if (!this.iceCandidatesQueue[fromId]) {
        this.iceCandidatesQueue[fromId] = [];
      }
      this.iceCandidatesQueue[fromId].push(candidate);
    }
  }

  // Process queued ICE candidates after remote description is set
  async processQueuedCandidates(fromId) {
    const pc = this.pcs[fromId];
    const queue = this.iceCandidatesQueue[fromId];
    if (pc && queue) {
      while (queue.length > 0) {
        const candidate = queue.shift();
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn("Error adding queued ICE candidate:", e);
        }
      }
    }
  }

  // Broadcast stream state (camera, mic, source) to peers
  broadcastStreamState(state) {
    this.lastVideoEnabled = state.videoEnabled;
    this.lastAudioEnabled = state.audioEnabled;
    this.lastStreamSource = state.streamSource;
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
          type: 'stream-state',
          from: this.userId,
          to: 'all',
          data: state
        }
      });
    }
  }

  // Disconnect session
  destroy() {
    if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
    if (this.channel) {
      this.channel.unsubscribe();
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
    }
    Object.keys(this.pcs).forEach(id => {
      this.pcs[id].close();
    });
    this.pcs = {};
    this.iceCandidatesQueue = {};
  }
}
