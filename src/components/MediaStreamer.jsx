import React, { useRef, useState, useEffect } from 'react';
import { Video, VideoOff, Mic, MicOff, Monitor, Radio, Tv, ShieldAlert, Sparkles, Presentation, CheckCircle2 } from 'lucide-react';

export default function MediaStreamer({ webrtcSession, isTeacher, connectionState, stream, remoteStreamState }) {
  const videoRef = useRef(null);
  const localPreviewRef = useRef(null);

  // Local media state (mirror for teacher/student)
  const [localVideoEnabled, setLocalVideoEnabled] = useState(isTeacher);
  const [localAudioEnabled, setLocalAudioEnabled] = useState(isTeacher);
  const [localStreamSource, setLocalStreamSource] = useState('camera'); // 'camera' | 'screen'

  // Remote state derived from broadcast
  const remoteVideoEnabled = remoteStreamState ? remoteStreamState.videoEnabled : isTeacher;
  const remoteAudioEnabled = remoteStreamState ? remoteStreamState.audioEnabled : isTeacher;
  const remoteStreamSource = remoteStreamState?.streamSource || 'camera';

  const slides = [
    {
      title: "Lecture 4: Interactive Blended Classroom Systems",
      subtitle: "Designing for High-Latency and Offline Sandbox Environments",
      bullets: [
        "Real-time student participation tracking via simulated event triggers",
        "Decentralized WebRTC signaling utilizing local BroadcastChannels",
        "Serialized canvas whiteboard vectors with automated local persistence",
      ],
    },
    {
      title: "Attendance Rules and Automation Telemetry",
      subtitle: "Eliminating Passive Absenteeism in Virtual Rooms",
      bullets: [
        "Students must answer at least 50% of the active classroom modules to be marked Present",
        "Manual overrides by the instructor immediately bypass automated scoring",
        "Anonymous responses preserve privacy but do NOT count towards attendance",
      ],
    },
    {
      title: "WebRTC Stream Projection Architecture",
      subtitle: "Clean Renegotiation-Free Media Distribution",
      bullets: [
        "WebRTC track replacements enable seamless transition from webcam to screen share",
        "Signaling and database states replicate across tabs via BroadcastChannels",
        "Pulsing signal fallbacks keep presentation visual interfaces responsive",
      ],
    },
    {
      title: "Whiteboard Synchronization & Analytics",
      subtitle: "Fulfilling PRD Session Completion Workflows",
      bullets: [
        "Interactive whiteboard drawing states debounced and synced every 1000ms",
        "Post-session telemetry dashboard compiles full attendance sheets",
        "One-click CSV downloads allow immediate gradebook exportation",
      ],
    },
  ];

  const [activeSlideIndex, setActiveSlideIndex] = useState(0);

  // Auto‑rotate slides when remote is screen sharing
  useEffect(() => {
    if (!isTeacher && remoteStreamSource === 'screen' && remoteVideoEnabled) {
      const iv = setInterval(() => setActiveSlideIndex(i => (i + 1) % slides.length), 7000);
      return () => clearInterval(iv);
    }
  }, [isTeacher, remoteStreamSource, remoteVideoEnabled]);

  // Attach remote (teacher) stream to main video element
  useEffect(() => {
    if (stream && videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  // Attach local stream to PIP preview (both roles)
  useEffect(() => {
    if (webrtcSession?.localStream && localPreviewRef.current) {
      localPreviewRef.current.srcObject = webrtcSession.localStream;
    }
  }, [webrtcSession?.localStream]);

  // Handle native "Stop Sharing" for screen share
  useEffect(() => {
    if (localStreamSource === 'screen' && webrtcSession?.localStream) {
      const vt = webrtcSession.localStream.getVideoTracks()[0];
      if (vt) {
        const onEnd = () => handleSourceChange('camera');
        vt.addEventListener('ended', onEnd);
        return () => vt.removeEventListener('ended', onEnd);
      }
    }
  }, [localStreamSource, webrtcSession?.localStream]);

  // ------- Media controls -------------------------------------------------
  const broadcastState = (video, audio, source) => {
    webrtcSession?.broadcastStreamState({ videoEnabled: video, audioEnabled: audio, streamSource: source });
  };

  const toggleVideo = async () => {
    const next = !localVideoEnabled;
    if (webrtcSession) {
      if (!webrtcSession.localStream && next) {
        // No stream at all – create a fresh one (camera)
        await webrtcSession.startLocalStream(localStreamSource);
      } else if (webrtcSession.localStream) {
        const videoTrack = webrtcSession.localStream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = next;
        } else if (next) {
          // Edge case: we lost the video track (e.g., after screen share)
          await webrtcSession.startLocalStream('camera');
        }
      }
    }
    setLocalVideoEnabled(next);
    broadcastState(next, localAudioEnabled, localStreamSource);
  };

  const toggleAudio = async () => {
    const next = !localAudioEnabled;
    if (webrtcSession) {
      if (!webrtcSession.localStream && next) {
        await webrtcSession.startLocalStream(localStreamSource);
      } else if (webrtcSession.localStream) {
        const audioTrack = webrtcSession.localStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = next;
        } else if (next) {
          // Recovery path – acquire microphone
          await webrtcSession.startLocalStream(localStreamSource);
        }
      }
    }
    setLocalAudioEnabled(next);
    broadcastState(localVideoEnabled, next, localStreamSource);
  };

  const handleSourceChange = async source => {
    if (!webrtcSession) return;
    setLocalStreamSource(source);
    setLocalVideoEnabled(true);
    await webrtcSession.startLocalStream(source);
    broadcastState(true, localAudioEnabled, source);
  };

  return (
    <div className="relative flex flex-col h-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl group min-h-[350px]">
        {/* Main streaming area */}
        <div className="relative flex-1 bg-slate-950 flex items-center justify-center overflow-hidden">
          {/* Remote video when available */}
          {connectionState === 'connected' && stream && remoteVideoEnabled && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className={`w-full h-full object-cover ${remoteStreamSource === 'camera' ? 'transform scale-x-[-1]' : ''}`}
            />
          )}
          {/* Fallback when video disabled, simulated, or no stream */}
          {(!remoteVideoEnabled || connectionState !== 'connected' || !stream) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-slate-950 via-purple-950/20 to-slate-950 p-6 text-center select-none">
              {/* Remote camera off placeholder */}
              {connectionState === 'connected' && stream && !remoteVideoEnabled ? (
                <div className="space-y-4 max-w-sm">
                  <div className="w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mx-auto animate-pulse">
                    <VideoOff className="w-8 h-8" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="font-semibold text-slate-200 text-sm md:text-base">Camera Feed Disabled</h4>
                    <p className="text-xs text-slate-400">The participant has turned off their camera. Audio is still active.</p>
                  </div>
                </div>
              ) : remoteStreamSource === 'screen' ? (
                // Show screen‑share slides when teacher is sharing their screen
                <div className="bg-slate-900/70 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-4 max-w-lg w-full text-left transition-all duration-500 animate-fade-in-up">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-2">
                      <Presentation className="w-4 h-4 text-purple-400" />
                      <span className="text-[10px] font-extrabold uppercase text-purple-400 tracking-wider">Instructor Lecture Slide</span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-bold bg-slate-950 px-2 py-0.5 rounded border border-slate-850">
                      Slide {activeSlideIndex + 1} of {slides.length}
                    </span>
                  </div>
                  <div className="space-y-3 min-h-[160px] flex flex-col justify-center">
                    <div className="space-y-1">
                      <h3 className="text-base font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-slate-100 to-slate-300">
                        {slides[activeSlideIndex].title}
                      </h3>
                      <p className="text-xs text-indigo-400 font-medium italic">{slides[activeSlideIndex].subtitle}</p>
                    </div>
                    <ul className="space-y-2">
                      {slides[activeSlideIndex].bullets.map((b, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex justify-center gap-1.5 pt-1.5 border-t border-slate-800/60">
                    {slides.map((_, i) => (
                      <button
                        key={i}
                        onClick={() => setActiveSlideIndex(i)}
                        className={`h-1.5 rounded-full transition-all duration-350 ${activeSlideIndex === i ? 'w-5 bg-purple-500' : 'w-1.5 bg-slate-800 hover:bg-slate-700'}`}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                // Simulated or offline placeholder
                <>
                  <div className="relative mb-6">
                    <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center text-purple-400 border border-purple-500/20 animate-pulse-ring">
                      <Radio className="w-8 h-8 animate-pulse text-purple-400" />
                    </div>
                    <span className="absolute -top-1 -right-1 flex h-4 w-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-4 w-4 bg-indigo-500 flex items-center justify-center text-[8px] font-bold text-white">LIVE</span>
                    </span>
                  </div>
                  <div className="space-y-2 max-w-sm">
                    <h4 className="font-semibold text-slate-200 text-sm md:text-base flex items-center justify-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-purple-400" /> Connecting Projection Stream
                    </h4>
                    <p className="text-xs text-slate-400">Waiting for WebRTC connection. Interactive simulation dashboard is online.</p>
                  </div>
                  {remoteAudioEnabled && (
                    <div className="flex items-center gap-1.5 mt-6 h-8">
                      {[1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1].map((v, i) => (
                        <div
                          key={i}
                          style={{ height: `${Math.max(10, Math.random() * 28)}px`, animationDelay: `${i * 0.05}s` }}
                          className="w-1 bg-gradient-to-t from-purple-500 to-indigo-400 rounded-full transition-all duration-150 animate-pulse-ring"
                        />
                      ))}
                    </div>
                  )}
                  {!remoteAudioEnabled && (
                    <p className="text-[10px] text-rose-400 mt-6 flex items-center gap-1 font-semibold">
                      <MicOff className="w-3.5 h-3.5" /> Audio Stream Muted
                    </p>
                  )}
                </>
              )}
              <div className="absolute bottom-4 left-4 bg-slate-900/90 backdrop-blur-md px-2.5 py-1 rounded-md border border-slate-800 text-[10px] text-slate-400 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3 text-purple-400" />
                <span>Signaling: Supabase presence channel</span>
              </div>
            </div>
          )}
          {/* Local PIP preview */}
          {localVideoEnabled && webrtcSession?.localStream && (
            <div className="absolute bottom-16 right-4 w-28 h-20 rounded-lg overflow-hidden border border-slate-700 bg-slate-950 shadow-2xl z-20 transition-all duration-300">
              <video
                ref={localPreviewRef}
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

        {/* Bottom control bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-slate-950 border-t border-slate-800 transition-all select-none">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleAudio}
              className={`p-2 rounded-lg border transition-all ${localAudioEnabled ? 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800' : 'bg-rose-950/20 text-rose-400 border-rose-900/30 hover:bg-rose-950/40'}`}
              title={localAudioEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
            >
              {localAudioEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            </button>
            <button
              onClick={toggleVideo}
              className={`p-2 rounded-lg border transition-all ${localVideoEnabled ? 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800' : 'bg-rose-950/20 text-rose-400 border-rose-900/30 hover:bg-rose-950/40'}`}
              title={localVideoEnabled ? 'Turn Camera Off' : 'Turn Camera On'}
            >
              {localVideoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => handleSourceChange('camera')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition-all ${localStreamSource === 'camera' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <Tv className="w-3.5 h-3.5" /> Camera
            </button>
            <button
              onClick={() => handleSourceChange('screen')}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold flex items-center gap-1 transition-all ${localStreamSource === 'screen' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <Monitor className="w-3.5 h-3.5" /> Screen
            </button>
          </div>
          <span className="text-[10px] text-slate-500 font-medium hidden sm:inline">
            {localVideoEnabled ? 'Local broadcast stream active' : 'Local media feed paused'}
          </span>
        </div>
    </div>
  );
}
