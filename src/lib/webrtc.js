import { supabase } from './supabaseClient';

// Helper: Retrieve ICE server configuration, including TURN when available.
function getIceServers() {
  // Detect local (development) environment – no TURN needed.
  if (typeof window !== 'undefined' && window.location) {
    const hn = window.location.hostname;
    const isLocal = hn === 'localhost' || hn === '127.0.0.1' || hn === '[::1]' ||
      hn.startsWith('192.168.') || hn.startsWith('10.') || hn.startsWith('172.') || hn.endsWith('.local');
    if (isLocal) {
      return [];
    }
  }
  // Primary STUN server.
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // Optional TURN configuration via environment variable (comma‑separated URLs).
  // Example: VITE_TURN_URL="turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp"
  const turnEnv = import.meta.env?.VITE_TURN_URL;
  if (turnEnv) {
    const turnUrls = turnEnv.split(',').map(u => u.trim()).filter(Boolean);
    if (turnUrls.length) {
      iceServers.push({ urls: turnUrls, username: import.meta.env?.VITE_TURN_USERNAME || '', credential: import.meta.env?.VITE_TURN_CREDENTIAL || '' });
    }
  }
  return iceServers;
}

// Apply a maximum video bitrate (in bits per second) to all video senders of a peer connection.
function applyVideoBitrate(pc, maxBitrate = 2500000) { // default 2.5 Mbps
  const videoSenders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
  videoSenders.forEach(sender => {
    try {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = maxBitrate;
      sender.setParameters(params).catch(() => {});
    } catch (e) {
      console.warn('Failed to set video bitrate:', e);
    }
  });
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
    this.iceCandidatesQueue = {}; // queue ICE candidates before remote description is set
    this.localStream = null;
    this.channel = null;

    // Track stream options to replay them to late‑joining students
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
          // Broadcast current stream state for late joiners
          this.broadcastStreamState({
            videoEnabled: this.lastVideoEnabled,
            audioEnabled: this.lastAudioEnabled,
            streamSource: this.lastStreamSource,
          });
        } else if (type === 'offer' && this.role === 'student') {
          await this.handleOffer(from, data);
        } else if (type === 'answer' && this.role === 'teacher') {
          await this.handleAnswer(from, data);
        } else if (type === 'ice-candidate') {
          await this.handleIceCandidate(from, data);
        } else if (type === 'teacher-joined' && this.role === 'student') {
          // Self‑healing: request connection if we missed the teacher‑joined broadcast
          this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'student-joined', from: this.userId, to: 'all' },
          });
          this.updateState('connecting');
          if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
          this.fallbackTimeout = setTimeout(() => {
            if (Object.keys(this.pcs).length === 0) this.updateState('simulated');
          }, 15000);
        } else if (type === 'stream-state') {
          if (this.onStreamStateChange) this.onStreamStateChange(data);
          // Re‑connect if we are a student with no active peer connection
          if (this.role === 'student' && Object.keys(this.pcs).length === 0) {
            this.channel.send({
              type: 'broadcast',
              event: 'signal',
              payload: { type: 'student-joined', from: this.userId, to: 'all' },
            });
            this.updateState('connecting');
            if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
            this.fallbackTimeout = setTimeout(() => {
              if (Object.keys(this.pcs).length === 0) this.updateState('simulated');
            }, 15000);
          }
        }
      } catch (err) {
        console.warn('WebRTC signal processing error: ', err);
        this.updateState('simulated');
      }
    });

    this.channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        if (this.role === 'student') {
          // Inform teacher we joined
          this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'student-joined', from: this.userId, to: 'all' },
          });
          this.updateState('connecting');
          this.fallbackTimeout = setTimeout(() => {
            if (Object.keys(this.pcs).length === 0) this.updateState('simulated');
          }, 15000);
        } else if (this.role === 'teacher') {
          // Inform students teacher is online
          this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: { type: 'teacher-joined', from: this.userId, to: 'all' },
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
        // 1. Acquire video first
        if (type === 'screen') {
          const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          videoTrack = screenStream.getVideoTracks()[0];
          if (videoTrack) {
            videoTrack.addEventListener('ended', () => {
              this.startLocalStream('camera');
              this.broadcastStreamState({
                videoEnabled: this.lastVideoEnabled,
                audioEnabled: this.lastAudioEnabled,
                streamSource: 'camera',
              });
            });
          }
        } else {
          const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
          videoTrack = cameraStream.getVideoTracks()[0];
        }
        // 2. Reuse existing audio track if live, otherwise acquire
        const existingAudioTrack = this.localStream?.getAudioTracks()[0];
        if (existingAudioTrack && existingAudioTrack.readyState === 'live') {
          audioTrack = existingAudioTrack;
        } else {
          try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioTrack = audioStream.getAudioTracks()[0];
          } catch (audioErr) {
            console.warn('Could not acquire microphone track:', audioErr);
          }
        }
        // 3. Stop old tracks that are being replaced
        if (this.localStream) {
          this.localStream.getVideoTracks().forEach(t => { if (t !== videoTrack) t.stop(); });
          this.localStream.getAudioTracks().forEach(t => { if (t !== audioTrack) t.stop(); });
        }
        // 4. Build new MediaStream
        const tracks = [];
        if (videoTrack) { videoTrack.enabled = this.lastVideoEnabled; tracks.push(videoTrack); }
        if (audioTrack) { audioTrack.enabled = this.lastAudioEnabled; tracks.push(audioTrack); }
        this.localStream = new MediaStream(tracks);
        // 5. Replace tracks in existing peer connections
        Object.keys(this.pcs).forEach(peerId => {
          const pc = this.pcs[peerId];
          const transceivers = pc.getTransceivers();
          const videoTransceiver = transceivers.find(t => t.receiver.track?.kind === 'video');
          const audioTransceiver = transceivers.find(t => t.receiver.track?.kind === 'audio');
          if (videoTransceiver && videoTrack) {
            videoTransceiver.sender.replaceTrack(videoTrack).catch(err => console.warn('Replace video track error:', err));
          }
          if (audioTransceiver && audioTrack) {
            audioTransceiver.sender.replaceTrack(audioTrack).catch(err => console.warn('Replace audio track error:', err));
          }
        });
        return this.localStream;
      } catch (err) {
        console.warn('Failed to acquire media stream:', err);
        if (!this.localStream) this.updateState('simulated');
        return this.localStream;
      }
    })();
    return this.streamPromise;
  }

  // Teacher initiates connection to a student
  async initiatePeerConnection(studentId) {
    if (this.pcs[studentId]) {
      try { this.pcs[studentId].close(); } catch (e) {}
    }
    if (this.streamPromise) await this.streamPromise;
    this.updateState('connecting');
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    this.pcs[studentId] = pc;
    // Add transceivers – use existing local tracks if present
    const videoTrack = this.localStream?.getVideoTracks()[0];
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (videoTrack) pc.addTransceiver(videoTrack, { direction: 'sendrecv' });
    else pc.addTransceiver('video', { direction: 'sendrecv' });
    if (audioTrack) pc.addTransceiver(audioTrack, { direction: 'sendrecv' });
    else pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.onicecandidate = event => {
      if (event.candidate) {
        this.channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: { type: 'ice-candidate', from: this.userId, to: studentId, data: event.candidate.toJSON() },
        });
      }
    };
    pc.ontrack = event => {
      if (!pc.remoteStream) pc.remoteStream = new MediaStream();
      if (!pc.remoteStream.getTracks().find(t => t.id === event.track.id)) pc.remoteStream.addTrack(event.track);
      if (this.onStream) this.onStream(pc.remoteStream, studentId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.updateState('connected');
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.updateState('simulated');
    };
    // Apply bitrate limits before creating the offer
    applyVideoBitrate(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { type: 'offer', from: this.userId, to: studentId, data: { type: offer.type, sdp: offer.sdp } },
    });
  }

  // Student responds to Teacher's offer
  async handleOffer(teacherId, offer) {
    if (this.pcs[teacherId]) { try { this.pcs[teacherId].close(); } catch (e) {} }
    if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
    this.updateState('connecting');
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    this.pcs[teacherId] = pc;
    pc.onicecandidate = event => {
      if (event.candidate) {
        this.channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: { type: 'ice-candidate', from: this.userId, to: teacherId, data: event.candidate.toJSON() },
        });
      }
    };
    pc.ontrack = event => {
      if (!pc.remoteStream) pc.remoteStream = new MediaStream();
      if (!pc.remoteStream.getTracks().find(t => t.id === event.track.id)) pc.remoteStream.addTrack(event.track);
      if (this.onStream) this.onStream(pc.remoteStream, teacherId);
      this.updateState('connected');
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.updateState('connected');
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.updateState('simulated');
    };
    // Remote description first – transceivers will be created automatically
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.processQueuedCandidates(teacherId);
    // Attach local tracks to transceivers (if we have a local stream)
    const transceivers = pc.getTransceivers();
    const videoTransceiver = transceivers.find(t => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');
    const audioTransceiver = transceivers.find(t => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio');
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (videoTransceiver && videoTrack) await videoTransceiver.sender.replaceTrack(videoTrack);
      if (audioTransceiver && audioTrack) await audioTransceiver.sender.replaceTrack(audioTrack);
    }
    // Ensure sendrecv direction
    if (videoTransceiver) videoTransceiver.direction = 'sendrecv';
    if (audioTransceiver) audioTransceiver.direction = 'sendrecv';
    // Apply bitrate limits for the student side as well
    applyVideoBitrate(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { type: 'answer', from: this.userId, to: teacherId, data: { type: answer.type, sdp: answer.sdp } },
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
      try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('Error adding ICE candidate directly:', e); }
    } else {
      if (!this.iceCandidatesQueue[fromId]) this.iceCandidatesQueue[fromId] = [];
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
        try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('Error adding queued ICE candidate:', e); }
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
          data: state,
        },
      });
    }
  }

  // Disconnect session and clean up resources
  destroy() {
    if (this.fallbackTimeout) clearTimeout(this.fallbackTimeout);
    if (this.channel) this.channel.unsubscribe();
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    Object.keys(this.pcs).forEach(id => { this.pcs[id].close(); });
    this.pcs = {};
    this.iceCandidatesQueue = {};
  }
}
