import React, { useRef, useState, useEffect } from 'react';
import { Video, VideoOff, Mic, MicOff, Monitor, Radio, Tv, ShieldAlert, Sparkles, Presentation, CheckCircle2 } from 'lucide-react';

export default function MediaStreamer({ webrtcSession, isTeacher, connectionState, stream, teacherStreamState }) {
  const videoRef = useRef(null);
  const studentVideoRef = useRef(null);
  
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [streamSource, setStreamSource] = useState('camera'); // 'camera' | 'screen'
  
  // Student local webcam preview states
  const [studentLocalStream, setStudentLocalStream] = useState(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);

  const slides = [
    {
      title: "Lecture 4: Interactive Blended Classroom Systems",
      subtitle: "Designing for High-Latency and Offline Sandbox Environments",
      bullets: [
        "Real-time student participation tracking via simulated event triggers",
        "Decentralized WebRTC signaling utilizing local BroadcastChannels",
        "Serialized canvas whiteboard vectors with automated local persistence"
      ]
    },
    {
      title: "Attendance Rules and Automation Telemetry",
      subtitle: "Eliminating Passive Absenteeism in Virtual Rooms",
      bullets: [
        "Students must answer at least 50% of the active classroom modules to be marked Present",
        "Manual overrides by the instructor immediately bypass automated scoring",
        "Anonymous responses preserve privacy but do NOT count towards attendance"
      ]
    },
    {
      title: "WebRTC Stream Projection Architecture",
      subtitle: "Clean Renegotiation-Free Media Distribution",
      bullets: [
        "WebRTC track replacements enable seamless transition from webcam to screen share",
        "Signaling and database states replicate across tabs via BroadcastChannels",
        "Pulsing signal fallbacks keep presentation visual interfaces responsive"
      ]
    },
    {
      title: "Whiteboard Synchronization & Analytics",
      subtitle: "Fulfilling PRD Session Completion Workflows",
      bullets: [
        "Interactive whiteboard drawing states debounced and synced every 1000ms",
        "Post-session telemetry dashboard compiles full attendance sheets",
        "One-click CSV downloads allow immediate gradebook exportation"
      ]
    }
  ];

  // Rotate slides automatically for screen sharing fallback
  useEffect(() => {
    if (!isTeacher && streamSource === 'screen' && videoEnabled) {
      const interval = setInterval(() => {
        setActiveSlideIndex(prev => (prev + 1) % slides.length);
      }, 7000);
      return () => clearInterval(interval);
    }
  }, [isTeacher, streamSource, videoEnabled]);

  // Set remote stream to student's video tag
  useEffect(() => {
    if (!isTeacher && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, isTeacher]);

  // Set local stream to teacher's video tag
  useEffect(() => {
    if (isTeacher && webrtcSession?.localStream && videoRef.current) {
      videoRef.current.srcObject = webrtcSession.localStream;
    }
  }, [webrtcSession?.localStream, isTeacher]);

  // Attach student local stream to thumbnail video
  useEffect(() => {
    if (!isTeacher && studentLocalStream && studentVideoRef.current) {
      studentVideoRef.current.srcObject = studentLocalStream;
    }
  }, [studentLocalStream, isTeacher]);

  // Clean up student local preview stream on unmount
  useEffect(() => {
    return () => {
      if (studentLocalStream) {
        studentLocalStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [studentLocalStream]);

  // Synchronize student's receiver view with teacher's broadcasted stream state
  useEffect(() => {
    if (!isTeacher && teacherStreamState) {
      setVideoEnabled(teacherStreamState.videoEnabled);
      setAudioEnabled(teacherStreamState.audioEnabled);
      setStreamSource(teacherStreamState.streamSource);
    }
  }, [teacherStreamState, isTeacher]);

  // Handle native "Stop Sharing" click from browser
  useEffect(() => {
    if (isTeacher && streamSource === 'screen' && webrtcSession?.localStream) {
      const videoTrack = webrtcSession.localStream.getVideoTracks()[0];
      if (videoTrack) {
        const handleTrackEnded = () => {
          handleSourceChange('camera');
        };
        videoTrack.addEventListener('ended', handleTrackEnded);
        return () => {
          videoTrack.removeEventListener('ended', handleTrackEnded);
        };
      }
    }
  }, [isTeacher, streamSource, webrtcSession?.localStream]);

  // Handle media controls
  const toggleVideo = async () => {
    if (isTeacher) {
      let nextVal = !videoEnabled;
      if (webrtcSession?.localStream) {
        const videoTrack = webrtcSession.localStream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = !videoTrack.enabled;
          nextVal = videoTrack.enabled;
        }
      }
      setVideoEnabled(nextVal);
      webrtcSession.broadcastStreamState({
        videoEnabled: nextVal,
        audioEnabled,
        streamSource
      });
    } else {
      // Student: Toggle local webcam preview overlay
      if (studentLocalStream) {
        studentLocalStream.getTracks().forEach(track => track.stop());
        setStudentLocalStream(null);
      } else {
        try {
          const mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 160, height: 120 },
            audio: false
          });
          setStudentLocalStream(mediaStream);
        } catch (err) {
          console.warn("Could not acquire student local camera stream:", err);
          alert("Could not access camera: " + err.message);
        }
      }
    }
  };

  const toggleAudio = () => {
    if (isTeacher) {
      if (webrtcSession?.localStream) {
        const audioTrack = webrtcSession.localStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled;
          const nextVal = audioTrack.enabled;
          setAudioEnabled(nextVal);
          
          webrtcSession.broadcastStreamState({
            videoEnabled,
            audioEnabled: nextVal,
            streamSource
          });
        }
      }
    } else {
      // Student: Toggle local mute of teacher feed
      setAudioEnabled(!audioEnabled);
    }
  };

  const handleSourceChange = async (source) => {
    if (!isTeacher || !webrtcSession) return;
    
    setStreamSource(source);
    const newStream = await webrtcSession.startLocalStream(source);
    if (newStream && videoRef.current) {
      videoRef.current.srcObject = newStream;
    }
    
    setVideoEnabled(true);
    
    webrtcSession.broadcastStreamState({
      videoEnabled: true,
      audioEnabled,
      streamSource: source
    });
  };

  return (
    <div className="relative flex flex-col h-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl group min-h-[350px]">
      
      {/* Stream Area */}
      <div className="relative flex-1 bg-slate-950 flex items-center justify-center overflow-hidden">
        
        {/* Render real video stream if connection is active and we have media */}
        {(connectionState === 'connected' || (isTeacher && webrtcSession?.localStream)) && videoEnabled ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isTeacher} // always mute local mic to avoid echo
            className={`w-full h-full object-cover ${(isTeacher && streamSource === 'camera') ? 'transform scale-x-[-1]' : ''}`}
          />
        ) : (
          /* PREVENT BLANK BLACK SCREEN: GORGEOUS SIMULATION STREAM & LECTURE DECK */
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-slate-950 via-purple-950/20 to-slate-950 p-6 text-center select-none">
            
            {/* Case 1: Video is disabled/muted by teacher */}
            {!videoEnabled ? (
              <div className="space-y-4 max-w-sm">
                <div className="w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mx-auto animate-pulse">
                  <VideoOff className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <h4 className="font-semibold text-slate-200 text-sm md:text-base">
                    Instructor Feed Paused
                  </h4>
                  <p className="text-xs text-slate-400">
                    The teacher has disabled the projection stream. Smart whiteboard is still available.
                  </p>
                </div>
              </div>
            ) : isTeacher || streamSource === 'camera' ? (
              /* Case 2: Camera Feed Simulation */
              <>
                <div className="relative mb-6">
                  <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center text-purple-400 border border-purple-500/20 animate-pulse-ring">
                    <Radio className="w-8 h-8 animate-pulse text-purple-400" />
                  </div>
                  <span className="absolute -top-1 -right-1 flex h-4 w-4">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-4 w-4 bg-indigo-500 flex items-center justify-center text-[8px] font-bold text-white">LIVE</span>
                  </span>
                </div>

                <div className="space-y-2 max-w-sm">
                  <h4 className="font-semibold text-slate-200 text-sm md:text-base flex items-center justify-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-purple-400" />
                    {isTeacher ? 'Broadcasting Stream Active' : 'Instructor Projection Stream'}
                  </h4>
                  <p className="text-xs text-slate-400">
                    {isTeacher 
                      ? 'WebRTC signaling channel is active. Video stream broadcast is routed to student portals.' 
                      : 'Receiving teacher broadcast. Standard system camera stream is active.'}
                  </p>
                </div>

                {/* Simulated Live Audio Waveform (bouncing divs) */}
                {audioEnabled && (
                  <div className="flex items-center gap-1.5 mt-6 h-8">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1].map((val, idx) => (
                      <div
                        key={idx}
                        style={{
                          height: `${Math.max(10, Math.random() * 28)}px`,
                          animationDelay: `${idx * 0.05}s`
                        }}
                        className="w-1 bg-gradient-to-t from-purple-500 to-indigo-400 rounded-full transition-all duration-150 animate-pulse-ring"
                      />
                    ))}
                  </div>
                )}
                
                {!audioEnabled && (
                  <p className="text-[10px] text-rose-400 mt-6 flex items-center gap-1 font-semibold">
                    <MicOff className="w-3.5 h-3.5" /> Audio Stream Muted
                  </p>
                )}
              </>
            ) : (
              /* Case 3: Student View - Slide Presentation Deck Fallback */
              <div className="bg-slate-900/70 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4 max-w-lg w-full text-left transition-all duration-500 animate-fade-in-up">
                
                {/* Slides Header */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Presentation className="w-4 h-4 text-purple-400" />
                    <span className="text-[10px] font-extrabold uppercase text-purple-400 tracking-wider">Instructor Lecture Slide</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-bold bg-slate-950 px-2 py-0.5 rounded border border-slate-850">
                    Slide {activeSlideIndex + 1} of {slides.length}
                  </span>
                </div>

                {/* Slide content */}
                <div className="space-y-3 min-h-[160px] flex flex-col justify-center">
                  <div className="space-y-1">
                    <h3 className="text-base font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-slate-100 to-slate-300">
                      {slides[activeSlideIndex].title}
                    </h3>
                    <p className="text-xs text-indigo-400 font-medium italic">
                      {slides[activeSlideIndex].subtitle}
                    </p>
                  </div>

                  <ul className="space-y-2">
                    {slides[activeSlideIndex].bullets.map((bullet, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Slide Dot indicators */}
                <div className="flex justify-center gap-1.5 pt-1.5 border-t border-slate-800/60">
                  {slides.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setActiveSlideIndex(idx)}
                      className={`h-1.5 rounded-full transition-all duration-350 ${
                        activeSlideIndex === idx ? 'w-5 bg-purple-500' : 'w-1.5 bg-slate-800 hover:bg-slate-700'
                      }`}
                    />
                  ))}
                </div>

              </div>
            )}

            <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur-md px-2.5 py-1 rounded-md border border-slate-800 text-[10px] text-slate-400 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-purple-400" />
              <span>Signaling: Supabase presence channel</span>
            </div>
          </div>
        )}

        {/* Top Floating Badge Bar */}
        <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase shadow-md flex items-center gap-1 pointer-events-auto ${
              connectionState === 'connected' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
              connectionState === 'connecting' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse' :
              'bg-purple-500/20 text-purple-400 border border-purple-500/30'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                connectionState === 'connected' ? 'bg-emerald-400' :
                connectionState === 'connecting' ? 'bg-amber-400' : 'bg-purple-400'
              }`} />
              {connectionState}
            </span>
            
            {isTeacher && (
              <span className="bg-slate-900/95 border border-slate-800 text-slate-400 text-[9px] px-2 py-0.5 rounded shadow pointer-events-auto font-medium">
                Source: {streamSource === 'camera' ? 'Webcam Camera' : 'Display Capture'}
              </span>
            )}
          </div>
        </div>

        {/* Student picture-in-picture local camera preview overlay */}
        {!isTeacher && studentLocalStream && (
          <div className="absolute bottom-16 right-4 w-28 h-20 rounded-lg overflow-hidden border border-slate-700 bg-slate-950 shadow-2xl z-20 transition-all duration-300">
            <video
              ref={studentVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover transform scale-x-[-1]"
            />
            <div className="absolute bottom-1 left-1 bg-slate-950/80 px-1 py-0.5 rounded text-[8px] text-slate-300 font-semibold select-none">
              You
            </div>
          </div>
        )}

      </div>

      {/* Floating Bottom Media Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950 border-t border-slate-800 transition-all select-none">
        
        {/* Left Side: Audio/Video toggles */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAudio}
            className={`p-2 rounded-lg border transition-all ${
              audioEnabled 
                ? 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800' 
                : 'bg-rose-950/20 text-rose-400 border-rose-900/30 hover:bg-rose-950/40'
            }`}
            title={audioEnabled ? "Mute Microphone" : "Unmute Microphone"}
          >
            {audioEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
          </button>

          <button
            onClick={toggleVideo}
            className={`p-2 rounded-lg border transition-all ${
              (isTeacher ? videoEnabled : studentLocalStream !== null)
                ? 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800' 
                : 'bg-rose-950/20 text-rose-400 border-rose-900/30 hover:bg-rose-950/40'
            }`}
            title={isTeacher ? (videoEnabled ? "Turn Camera Off" : "Turn Camera On") : (studentLocalStream ? "Close My Camera" : "Open My Camera")}
          >
            {(isTeacher ? videoEnabled : studentLocalStream !== null) ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
          </button>
        </div>

        {/* Right Side: Media Source switching (Teacher only) */}
        {isTeacher && (
          <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => handleSourceChange('camera')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition-all ${
                streamSource === 'camera' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 disabled:opacity-30'
              }`}
            >
              <Tv className="w-3.5 h-3.5" />
              Camera
            </button>
            <button
              onClick={() => handleSourceChange('screen')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition-all ${
                streamSource === 'screen' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200 disabled:opacity-30'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              Screen
            </button>
          </div>
        )}

        {!isTeacher && (
          <span className="text-[10px] text-slate-500 font-medium">
            {studentLocalStream ? "Local camera preview active" : "Privacy mode: student camera muted by default"}
          </span>
        )}

      </div>
    </div>
  );
}
