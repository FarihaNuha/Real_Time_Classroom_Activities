import React, { useState, useEffect, useRef } from 'react';
import { supabase, isSimulated } from '../lib/supabaseClient';
import { WebRTCSession } from '../lib/webrtc';
import Whiteboard from './Whiteboard';
import LiveActivities from './LiveActivities';
import MediaStreamer from './MediaStreamer';
import PostSessionReport from './PostSessionReport';
import { 
  Users, LogOut, Video, Edit3, MessageCircle, 
  Send, RefreshCw, Key, Shield, User, Play, 
  Square, AlertCircle, ChevronUp, ChevronDown, CheckCircle, XCircle,
  Lock, Unlock
} from 'lucide-react';
import confetti from 'canvas-confetti';

const formatTime = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function SessionDashboard({ session, profile, onLeave }) {
  const isTeacher = profile.role === 'teacher';
  
  // Tabs & Layout
  const [activeTab, setActiveTab] = useState('whiteboard'); // 'stream' | 'whiteboard'
  const [drawerOpen, setDrawerOpen] = useState(true);
  
  // Real-time Session state
  const [currentOtp, setCurrentOtp] = useState(session.otp);
  const [sessionStatus, setSessionStatus] = useState(session.status);
  const [isSessionLocked, setIsSessionLocked] = useState(session.is_locked || false);
  const [totalActivities, setTotalActivities] = useState(session.total_activities || 0);
  const [participants, setParticipants] = useState([]);
  
  // WebRTC Stream state
  const [webrtc, setWebrtc] = useState(null);
  const [webrtcState, setWebrtcState] = useState('simulated');
  const [remoteStream, setRemoteStream] = useState(null);
  const [teacherStreamState, setTeacherStreamState] = useState({
    videoEnabled: true,
    audioEnabled: true,
    streamSource: 'camera'
  });

  // Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [isChatAnonymous, setIsChatAnonymous] = useState(false);
  const chatEndRef = useRef(null);
  const lastStateRef = useRef(teacherStreamState);

  // Synchronize student active tab with teacher stream transitions
  useEffect(() => {
    if (isTeacher) return;
    if (!teacherStreamState) return;

    const prev = lastStateRef.current;
    
    // 1. Started screen sharing or enabled camera (videoEnabled becomes true, or streamSource changes while videoEnabled is true)
    const turnedOn = teacherStreamState.videoEnabled && (!prev || !prev.videoEnabled);
    const sourceChanged = teacherStreamState.videoEnabled && prev && prev.videoEnabled && (prev.streamSource !== teacherStreamState.streamSource);
    
    if (turnedOn || sourceChanged) {
      setActiveTab('stream');
    }
    
    // 2. Stopped screen sharing or turned off camera (videoEnabled becomes false)
    const turnedOff = !teacherStreamState.videoEnabled && prev && prev.videoEnabled;
    if (turnedOff) {
      setActiveTab('whiteboard');
    }

    lastStateRef.current = teacherStreamState;
  }, [teacherStreamState, isTeacher]);

  // Load chat and participants on join
  useEffect(() => {
    // 1. Fetch initial participants
    const fetchParticipants = async () => {
      const { data } = await supabase
        .from('session_participants')
        .select(`
          id,
          student_id,
          activities_completed,
          participation_percentage,
          is_present,
          manual_override,
          profiles (full_name, student_id)
        `)
        .eq('session_id', session.id);
      
      if (data) {
        // Format nicely
        const formatted = data.map(p => ({
          id: p.id,
          studentId: p.student_id,
          fullName: p.profiles?.full_name || 'Anonymous Student',
          universityId: p.profiles?.student_id || 'STU-MOCK',
          activitiesCompleted: p.activities_completed,
          percentage: parseFloat(p.participation_percentage || 0),
          isPresent: p.is_present,
          manualOverride: p.manual_override
        }));
        setParticipants(formatted);
      }
    };

    fetchParticipants();

    // 2. Fetch recent chat messages
    const fetchChat = async () => {
      const { data } = await supabase
        .from('chat')
        .select('*')
        .eq('session_id', session.id)
        .order('created_at', { ascending: true });
      if (data) setChatMessages(data);
    };
    fetchChat();

    // 3. Setup participants real-time listener
    const partChannel = supabase
      .channel(`participants-sync-${session.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'session_participants',
        filter: `session_id=eq.${session.id}`
      }, async (payload) => {
        // Query full details to update names
        const { data: newPart } = await supabase
          .from('session_participants')
          .select(`
            id,
            student_id,
            activities_completed,
            participation_percentage,
            is_present,
            manual_override,
            profiles (full_name, student_id)
          `)
          .eq('id', payload.new.id)
          .single();

        if (newPart) {
          const item = {
            id: newPart.id,
            studentId: newPart.student_id,
            fullName: newPart.profiles?.full_name || 'Anonymous Student',
            universityId: newPart.profiles?.student_id || 'STU-MOCK',
            activitiesCompleted: newPart.activities_completed,
            percentage: parseFloat(newPart.participation_percentage || 0),
            isPresent: newPart.is_present,
            manualOverride: newPart.manual_override
          };

          setParticipants(prev => {
            const index = prev.findIndex(p => p.id === item.id);
            if (index !== -1) {
              const updated = [...prev];
              updated[index] = item;
              return updated;
            }
            return [...prev, item];
          });
        }
      })
      .subscribe();

    // 4. Setup session status/otp subscription
    const sessionChan = supabase
      .channel(`session-status-${session.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'sessions',
        filter: `id=eq.${session.id}`
      }, payload => {
        if (payload.new) {
          setCurrentOtp(payload.new.otp);
          setSessionStatus(payload.new.status);
          setIsSessionLocked(payload.new.is_locked || false);
          setTotalActivities(payload.new.total_activities || 0);
        }
      })
      .subscribe();

    // 5. Setup WebRTC Session
    const webrtcSession = new WebRTCSession(
      session.id,
      profile.id,
      profile.role,
      (stream) => setRemoteStream(stream),
      (state) => setWebrtcState(state),
      (streamState) => setTeacherStreamState(streamState)
    );

    setWebrtc(webrtcSession);
    if (isTeacher) {
      webrtcSession.startLocalStream('camera');
    }

    return () => {
      partChannel.unsubscribe();
      sessionChan.unsubscribe();
      webrtcSession.destroy();
    };
  }, [session.id, profile.id, profile.role]);

  // Handle Real-time Chat subscriptions via Supabase Broadcast (fast, real-time)
  useEffect(() => {
    const chatChannel = supabase.channel(`chat-room-${session.id}`);

    chatChannel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      setChatMessages(prev => {
        // Prevent dupes
        if (prev.find(m => m.id === payload.id)) return prev;
        return [...prev, payload];
      });
      scrollToBottom();
    });

    chatChannel.subscribe();

    return () => {
      chatChannel.unsubscribe();
    };
  }, [session.id]);

  const scrollToBottom = () => {
    setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  // Generate dynamic 4-digit OTP key
  const handleRegenerateOtp = async () => {
    if (!isTeacher) return;
    const newOtp = Math.floor(1000 + Math.random() * 9000).toString();
    try {
      const { error } = await supabase
        .from('sessions')
        .update({ otp: newOtp })
        .eq('id', session.id);
      
      if (!error) {
        setCurrentOtp(newOtp);
        confetti({ particleCount: 15, spread: 20, colors: ['#a855f7'] });
      }
    } catch(err) {
      console.error(err);
    }
  };

  // Update session status (e.g. End Session)
  const handleEndSession = async () => {
    if (!window.confirm('Are you sure you want to end this classroom session? This will generate reports.')) return;
    
    try {
      const { error } = await supabase
        .from('sessions')
        .update({ status: 'ended' })
        .eq('id', session.id);
      
      if (!error) {
        setSessionStatus('ended');
      }
    } catch(err) {
      console.error(err);
    }
  };

  // Toggle classroom joins locked/unlocked state
  const handleToggleLock = async () => {
    if (!isTeacher) return;
    const nextLocked = !isSessionLocked;
    try {
      const { error } = await supabase
        .from('sessions')
        .update({ is_locked: nextLocked })
        .eq('id', session.id);
      
      if (!error) {
        setIsSessionLocked(nextLocked);
        confetti({ particleCount: 15, spread: 20, colors: [nextLocked ? '#ef4444' : '#10b981'] });
      }
    } catch(err) {
      console.error(err);
    }
  };

  // Chat message submission
  const handleSendChat = async (e) => {
    e.preventDefault();
    if (!newMsg.trim()) return;

    const anonymous = !isTeacher && isChatAnonymous;

    const payloadMsg = {
      id: crypto.randomUUID(),
      session_id: session.id,
      sender_id: anonymous ? 'anonymous' : profile.id,
      sender_name: anonymous ? 'Anonymous Student' : profile.full_name,
      sender_role: profile.role,
      content: newMsg.trim(),
      created_at: new Date().toISOString()
    };

    // 1. Save in local database (so it persists)
    try {
      await supabase.from('chat').insert(payloadMsg);
    } catch(err) {
      console.warn("DB chat sync issue:", err);
    }

    // 2. Broadcast via Supabase Broadcast (instant message reflection)
    const chatChannel = supabase.channel(`chat-room-${session.id}`);
    chatChannel.send({
      type: 'broadcast',
      event: 'msg',
      payload: payloadMsg
    });

    setChatMessages(prev => [...prev, payloadMsg]);
    setNewMsg('');
    scrollToBottom();
  };

  // Teacher manual override attendance toggle
  const handleOverrideToggle = async (participant) => {
    if (!isTeacher) return;
    
    const nextOverride = !participant.manualOverride;
    // If override is enabled, toggle presence. If disabled, let database recompute.
    // In override, we toggle isPresent. Let's make toggle logic:
    // If NOT overridden yet: we override and set isPresent to opposite of current.
    // If already overridden: we toggle presence. If they double click to turn override off, we reset.
    let nextPresent = !participant.isPresent;
    
    try {
      const { error } = await supabase
        .from('session_participants')
        .update({
          manual_override: nextOverride,
          is_present: nextOverride ? nextPresent : participant.isPresent // DB trigger handles recalculations when override set to false
        })
        .eq('id', participant.id);

      if (error) throw error;
    } catch (err) {
      alert("Failed to update override: " + err.message);
    }
  };

  const handleOverrideStatusChange = async (participant, forcePresent) => {
    try {
      const { error } = await supabase
        .from('session_participants')
        .update({
          manual_override: true,
          is_present: forcePresent
        })
        .eq('id', participant.id);
      if (error) throw error;
    } catch (err) {
      alert("Failed to update status: " + err.message);
    }
  };

  const handleDisableOverride = async (participant) => {
    try {
      const { error } = await supabase
        .from('session_participants')
        .update({
          manual_override: false
        })
        .eq('id', participant.id);
      if (error) throw error;
    } catch (err) {
      alert("Failed to update override: " + err.message);
    }
  };

  // Student personal telemetry
  const myParticipant = participants.find(p => p.studentId === profile.id);

  // If session status changed to ended, render PostSessionReport (Teacher) or Class Ended screen (Student)
  if (sessionStatus === 'ended') {
    if (isTeacher) {
      return (
        <PostSessionReport 
          sessionId={session.id} 
          isTeacher={isTeacher} 
          sessionTitle={session.title} 
          onClose={onLeave} 
        />
      );
    } else {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-slate-100 p-6 text-center select-none font-sans relative">
          {/* Ambient glowing blobs */}
          <div className="absolute top-1/4 left-1/4 w-72 h-72 rounded-full bg-purple-600/10 blur-[100px] pointer-events-none" />
          <div className="absolute bottom-1/4 right-1/4 w-72 h-72 rounded-full bg-indigo-600/10 blur-[100px] pointer-events-none" />
          
          <div className="relative z-10 max-w-md w-full bg-slate-900/80 backdrop-blur-xl border border-slate-800/80 p-8 rounded-2xl shadow-2xl space-y-6 animate-fade-in-up">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mx-auto animate-pulse-ring">
                <CheckCircle className="w-8 h-8 text-purple-400" />
              </div>
              <span className="absolute top-0 right-[calc(50%-2rem)] flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-500"></span>
              </span>
            </div>

            <div className="space-y-2">
              <h2 className="text-xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-slate-100 to-slate-300">
                Class Session Ended
              </h2>
              <p className="text-xs text-slate-400">
                The instructor has concluded this classroom session.
              </p>
            </div>

            <div className="bg-slate-950/50 p-5 rounded-xl border border-slate-800/80 text-left text-xs text-slate-300 space-y-3 shadow-inner">
              <p className="font-bold text-purple-400 flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-purple-400" />
                Session Concluded
              </p>
              <ul className="space-y-2 text-slate-450 text-[11px] list-none pl-0">
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">✔</span>
                  <span>All active quiz & poll responses have been compiled.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">✔</span>
                  <span>Your attendance record has been logged successfully.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">✔</span>
                  <span>Drawing notebook and lectures have been archived.</span>
                </li>
              </ul>
            </div>

            <button
              onClick={onLeave}
              className="w-full py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white rounded-xl text-xs font-bold transition-all shadow-lg hover:shadow-purple-500/10 border border-purple-500/30"
            >
              Exit to Dashboard
            </button>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      
      {/* 1. Header Area */}
      <header className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 bg-slate-900 border-b border-slate-800 shadow-lg shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg text-lg">
            A
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-slate-100">{session.title}</h1>
              <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full border border-emerald-500/20 font-semibold animate-pulse-ring uppercase">Active</span>
            </div>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
              <User className="w-3.5 h-3.5" /> {isTeacher ? 'Host (Teacher)' : 'Joined as Student'}
            </p>
          </div>
        </div>

        {/* Room Code & Dynamic OTP Display */}
        <div className="flex items-center gap-3 bg-slate-950 px-4 py-2 rounded-xl border border-slate-800 shadow-inner">
          <div className="text-center pr-3 border-r border-slate-800">
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Room Code</span>
            <span className="text-sm font-extrabold text-purple-400 tracking-wider font-mono">{session.room_code}</span>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-center">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">One-Time OTP</span>
              <span className="text-sm font-extrabold text-indigo-400 font-mono tracking-widest">{currentOtp}</span>
            </div>
            {isTeacher && (
              <button
                onClick={handleRegenerateOtp}
                className="p-1 text-slate-400 hover:text-white hover:bg-slate-900 rounded transition-all"
                title="Regenerate dynamic OTP key"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* End / Leave Class actions */}
        <div className="flex items-center gap-2">
          {isTeacher ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleToggleLock}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow border ${
                  isSessionLocked 
                    ? 'bg-amber-600/10 hover:bg-amber-600 text-amber-400 hover:text-white border-amber-500/25' 
                    : 'bg-emerald-600/10 hover:bg-emerald-600 text-emerald-400 hover:text-white border-emerald-500/25'
                }`}
                title={isSessionLocked ? "Click to unlock classroom joining" : "Click to lock classroom joining"}
              >
                {isSessionLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                {isSessionLocked ? 'Unlock Room' : 'Lock Room'}
              </button>
              <button
                onClick={handleEndSession}
                className="flex items-center gap-1.5 px-4 py-2 bg-rose-600/10 hover:bg-rose-600 text-rose-400 hover:text-white rounded-xl text-xs font-bold border border-rose-500/20 transition-all shadow"
              >
                <Square className="w-3.5 h-3.5" />
                End Classroom
              </button>
            </div>
          ) : (
            <button
              onClick={onLeave}
              className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition-all shadow border border-slate-700"
            >
              <LogOut className="w-3.5 h-3.5" />
              Exit Room
            </button>
          )}
        </div>
      </header>

      {/* Offline simulation warning */}
      {isSimulated && (
        <div className="bg-indigo-950/40 border-b border-indigo-900/40 px-6 py-2 flex items-center justify-between text-xs text-indigo-300 shrink-0">
          <span className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-indigo-400" />
            Connected via <strong>Simulated Sandbox Engine</strong>. In-memory data persistence active.
          </span>
          <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-400/20">No Real DB required</span>
        </div>
      )}

      {/* 2. Main Workspace Layout */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">
        
        {/* Left Component Panel (65% width on desktop, full screen on mobile when whiteboard/stream active) */}
        <main className={`flex-1 lg:w-[65%] lg:flex flex-col p-4 space-y-4 overflow-hidden h-full ${
          (activeTab === 'whiteboard' || activeTab === 'stream') ? 'flex' : 'hidden lg:flex'
        }`}>
          {/* Tab switcher buttons */}
          <div className="flex items-center justify-between bg-slate-900/60 p-1 rounded-xl border border-slate-800/80 shrink-0">
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => setActiveTab('whiteboard')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activeTab === 'whiteboard' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Edit3 className="w-3.5 h-3.5" />
                Smart Whiteboard
              </button>

              <button
                onClick={() => setActiveTab('stream')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activeTab === 'stream' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Video className="w-3.5 h-3.5" />
                Live Projection Stream
              </button>

              <button
                onClick={() => setActiveTab('activities')}
                className={`lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activeTab === 'activities' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Activities
              </button>

              <button
                onClick={() => setActiveTab('chat')}
                className={`lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activeTab === 'chat' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Chat
              </button>
            </div>
            
            <div className="flex items-center gap-2 text-[10px] text-slate-500 mr-2">
              <Users className="w-3.5 h-3.5 text-slate-400" />
              <span>{participants.length} connected</span>
            </div>
          </div>

          {/* Active Workspace View */}
          <div className="flex-1 overflow-hidden min-h-0">
            {activeTab === 'whiteboard' ? (
              <Whiteboard sessionId={session.id} isTeacher={isTeacher} />
            ) : (
              <MediaStreamer 
                webrtcSession={webrtc} 
                isTeacher={isTeacher} 
                connectionState={webrtcState} 
                stream={remoteStream} 
                teacherStreamState={teacherStreamState}
              />
            )}
          </div>
        </main>

        {/* Right Sidebar Widget Panel (35% width on desktop, full screen on mobile when activities/chat active) */}
        <aside className={`lg:w-[35%] lg:border-t-0 lg:border-l border-slate-800 bg-slate-950 lg:flex flex-col overflow-hidden h-full ${
          (activeTab === 'activities' || activeTab === 'chat') ? 'flex flex-1 p-4' : 'hidden lg:flex'
        }`}>
          {/* Mobile Back & Sub-tab switcher */}
          <div className="lg:hidden flex items-center justify-between mb-4 bg-slate-900/60 p-1 rounded-xl border border-slate-800/80 shrink-0">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab('whiteboard')}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400 hover:text-slate-200"
              >
                ← Workspace
              </button>
              
              <button
                onClick={() => setActiveTab('activities')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activeTab === 'activities' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Activities
              </button>

              <button
                onClick={() => setActiveTab('chat')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  activeTab === 'chat' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Chat
              </button>
            </div>
          </div>

          {/* Top: Quizzes & Activities widget */}
          <div className={`flex-1 min-h-[300px] border-b border-slate-800 overflow-hidden flex flex-col ${
            (activeTab === 'activities') ? 'flex' : 'hidden lg:flex'
          }`}>
            <LiveActivities 
              sessionId={session.id} 
              isTeacher={isTeacher} 
              currentStudentId={profile.id} 
              participants={participants}
              profile={profile}
            />
          </div>

          {/* Bottom: Real-time Group Chat widget */}
          <div className={`shrink-0 flex flex-col bg-slate-900/30 overflow-hidden ${
            (activeTab === 'chat') ? 'flex-1 flex' : 'hidden lg:flex lg:h-[280px]'
          }`}>
            <div className="px-4 py-2.5 bg-slate-950 border-b border-slate-800 flex items-center gap-2 text-xs font-bold text-slate-300">
              <MessageCircle className="w-4 h-4 text-purple-400" />
              Group Chat Channel
            </div>

            {/* Message feed */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              {chatMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center text-slate-600">
                  <MessageCircle className="w-6 h-6 mb-1 text-slate-700" />
                  <p className="text-[10px]">No messages. Send a message to start.</p>
                </div>
              ) : (
                chatMessages.map((msg) => {
                  const isMe = msg.sender_id === profile.id;
                  const isMsgTeacher = msg.sender_role === 'teacher';
                  return (
                    <div 
                      key={msg.id} 
                      className={`flex flex-col max-w-[85%] ${isMe ? 'ml-auto items-end' : 'mr-auto items-start'}`}
                    >
                      <div className="flex items-center gap-1 text-[9px] text-slate-500 mb-0.5 px-1">
                        <span className={`font-semibold ${isMsgTeacher ? 'text-indigo-400' : 'text-slate-400'}`}>
                          {msg.sender_name}
                        </span>
                        {isMsgTeacher && <span className="bg-indigo-500/10 text-indigo-400 px-1 rounded text-[8px]">Teacher</span>}
                        <span>•</span>
                        <span>{formatTime(msg.created_at)}</span>
                      </div>
                      
                      <div className={`px-3 py-2 rounded-xl text-xs break-all ${
                        isMe 
                          ? 'bg-purple-600 text-white rounded-tr-none' 
                          : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700/50'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input Form */}
            <form onSubmit={handleSendChat} className="p-2 bg-slate-950 border-t border-slate-800 flex flex-col gap-2 shrink-0">
              <div className="flex gap-2 w-full">
                <input
                  type="text"
                  value={newMsg}
                  onChange={(e) => setNewMsg(e.target.value)}
                  placeholder="Send a group message..."
                  className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <button
                  type="submit"
                  className="p-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-all shadow"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
              {!isTeacher && (
                <div className="flex items-center gap-1.5 px-1">
                  <input
                    type="checkbox"
                    id="chat-anonymous"
                    checked={isChatAnonymous}
                    onChange={(e) => setIsChatAnonymous(e.target.checked)}
                    className="rounded border-slate-800 bg-slate-900 text-purple-600 focus:ring-purple-500 h-3 w-3"
                  />
                  <label htmlFor="chat-anonymous" className="text-[9px] select-none text-slate-500 hover:text-slate-400">
                    Send anonymously (shows as Anonymous Student)
                  </label>
                </div>
              )}
            </form>
          </div>
        </aside>
      </div>

      {/* 3. Collapsible Drawer Panel (Live Monitoring Panel) */}
      <footer className="bg-slate-900 border-t border-slate-800 shrink-0 select-none z-10">
        
        {/* Drawer Trigger tab */}
        <div 
          onClick={() => setDrawerOpen(!drawerOpen)}
          className="flex items-center justify-between px-6 py-2.5 bg-slate-950 border-b border-slate-800 cursor-pointer hover:bg-slate-900 transition-all"
        >
          <div className="flex items-center gap-3">
            <Users className="w-4 h-4 text-purple-400" />
            <span className="text-xs font-semibold text-slate-300">
              {isTeacher 
                ? `Connected Students: ${participants.length} | Active (Present): ${participants.filter(p => p.isPresent).length}`
                : `My Participation: ${myParticipant ? `${myParticipant.activitiesCompleted}/${totalActivities}` : `0/${totalActivities}`} (${myParticipant ? myParticipant.percentage : 0}%) (${myParticipant?.isPresent ? 'Present' : 'Absent'})`}
            </span>
          </div>
          
          <div className="flex items-center gap-1.5 text-slate-500 text-xs">
            <span className="text-[10px] uppercase font-bold tracking-wider hidden sm:inline">
              {drawerOpen ? 'Collapse Monitor' : 'Expand Monitor'}
            </span>
            {drawerOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </div>
        </div>

        {/* Drawer Content */}
        {drawerOpen && (
          <div className="p-4 max-h-48 overflow-y-auto bg-slate-900/60 transition-all duration-300">
            {isTeacher ? (
              /* TEACHER MONITOR: ALL PARTICIPANTS TABLE */
              participants.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-4">No students have joined yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs text-slate-300">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                        <th className="pb-2">Student ID</th>
                        <th className="pb-2">Full Name</th>
                        <th className="pb-2 text-center">Activities Completed</th>
                        <th className="pb-2 text-center">Participation Rate</th>
                        <th className="pb-2 text-center">Status</th>
                        <th className="pb-2 text-center">Override Flags</th>
                        <th className="pb-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {participants.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-800/40">
                          <td className="py-2.5 font-mono text-[11px] text-purple-400 font-semibold">{p.universityId}</td>
                          <td className="py-2.5 font-medium text-slate-200">{p.fullName}</td>
                          <td className="py-2.5 text-center font-bold">{p.activitiesCompleted} / {totalActivities}</td>
                          <td className="py-2.5 text-center">
                            <span className={`px-2 py-0.5 rounded font-mono ${
                              p.percentage >= 50 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                            }`}>
                              {p.percentage}%
                            </span>
                          </td>
                          <td className="py-2.5 text-center">
                            {p.isPresent ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 text-[11px]">
                                ✔ Present
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold bg-rose-500/15 text-rose-400 border border-rose-500/20 text-[11px]">
                                ✘ Absent
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 text-center">
                            {p.manualOverride ? (
                              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] px-1.5 py-0.5 rounded font-semibold">
                                OVERRIDDEN
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-600 font-semibold">AUTOMATIC</span>
                            )}
                          </td>
                          <td className="py-2.5 text-right space-x-1.5">
                            {p.manualOverride ? (
                              <div className="inline-flex gap-1.5">
                                <button
                                  onClick={() => handleOverrideStatusChange(p, true)}
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all ${
                                    p.isPresent 
                                      ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30' 
                                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                                  }`}
                                >
                                  Present
                                </button>
                                <button
                                  onClick={() => handleOverrideStatusChange(p, false)}
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all ${
                                    !p.isPresent 
                                      ? 'bg-rose-600/20 text-rose-400 border-rose-500/30' 
                                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                                  }`}
                                >
                                  Absent
                                </button>
                                <button
                                  onClick={() => handleDisableOverride(p)}
                                  className="px-2 py-0.5 bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded text-[10px]"
                                  title="Restore automatic trigger calculation"
                                >
                                  Reset Auto
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => handleOverrideToggle(p)}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-purple-950/40 border border-slate-700 hover:border-purple-900/30 text-slate-400 hover:text-purple-400 rounded text-[10px] font-bold transition-all"
                              >
                                Override Attendance
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              /* STUDENT MONITOR: INDIVIDUAL SUMMARY METRIC */
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">Activities Completed</span>
                    <span className="text-lg font-bold text-slate-200">
                      {myParticipant?.activitiesCompleted || 0} / {totalActivities}
                    </span>
                  </div>
                  <CheckCircle className="w-6 h-6 text-purple-400" />
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">My Participation Percentage</span>
                    <span className="text-sm font-extrabold text-indigo-400">{myParticipant?.percentage || 0}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div 
                      style={{ width: `${Math.min(100, myParticipant?.percentage || 0)}%` }} 
                      className={`h-full rounded-full transition-all duration-300 ${
                        (myParticipant?.percentage || 0) >= 50 ? 'bg-emerald-500' : 'bg-rose-500'
                      }`}
                    />
                  </div>
                  <span className="text-[9px] text-slate-500 block mt-1">Requires 50% participation threshold to clear attendance</span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">Attendance Status</span>
                    <span className={`text-sm font-extrabold flex items-center gap-1.5 mt-0.5 ${
                      myParticipant?.isPresent ? 'text-emerald-400' : 'text-slate-500'
                    }`}>
                      {myParticipant?.isPresent ? 'PRESENT' : 'ABSENT / INSUFFICIENT'}
                    </span>
                  </div>
                  {myParticipant?.manualOverride && (
                    <span className="bg-amber-500/10 text-amber-400 text-[8px] px-1.5 py-0.5 rounded border border-amber-400/20 font-bold uppercase">
                      Override Active
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </footer>

    </div>
  );
}
