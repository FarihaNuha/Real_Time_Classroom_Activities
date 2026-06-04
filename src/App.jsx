import React, { useState, useEffect } from 'react';
import { supabase, isSimulated } from './lib/supabaseClient';
import SessionDashboard from './components/SessionDashboard';
import PostSessionReport from './components/PostSessionReport';
import { 
  Users, Key, Shield, User, Sparkles, BookOpen, 
  HelpCircle, LogOut, ChevronRight, Video, FileText, 
  CheckCircle, Plus, LayoutGrid, Check, Settings, AlertCircle 
} from 'lucide-react';
import confetti from 'canvas-confetti';

function App() {
  // Authentication states
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  
  // Auth Form states
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('student');
  const [studentId, setStudentId] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Classrooms list / states
  const [mySessions, setMySessions] = useState([]);
  const [newClassTitle, setNewClassTitle] = useState('');
  const [classroomLoading, setClassroomLoading] = useState(false);

  // Student joining states
  const [joinRoomCode, setJoinRoomCode] = useState('');
  const [joinOtp, setJoinOtp] = useState('');
  const [joinError, setJoinError] = useState('');

  // Active Session state
  const [activeSession, setActiveSession] = useState(null);
  const [reportSessionId, setReportSessionId] = useState(null);

  // 1. Auth Change Listener
  useEffect(() => {
    // Check initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user);
        fetchProfile(session.user.id);
      } else {
        setAuthLoading(false);
      }
    });

    // Listen for auth events
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        setUser(session.user);
        fetchProfile(session.user.id);
      } else {
        setUser(null);
        setProfile(null);
        setMySessions([]);
        setAuthLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // 2. Fetch User Profile & Classes
  const fetchProfile = async (uid) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', uid)
        .single();
      
      if (data) {
        setProfile(data);
        fetchUserSessions(data);
      } else {
        // Fallback for user record missing
        setProfile({ id: uid, full_name: user?.email || 'User', role: 'student' });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setAuthLoading(false);
    }
  };

  const fetchUserSessions = async (userProfile) => {
    try {
      if (userProfile.role === 'teacher') {
        // Teacher sees classes they host
        const { data } = await supabase
          .from('sessions')
          .select('*')
          .eq('teacher_id', userProfile.id)
          .order('created_at', { ascending: false });
        if (data) setMySessions(data);
      } else {
        // Student sees classes they have joined
        const { data } = await supabase
          .from('session_participants')
          .select(`
            session_id,
            sessions (*)
          `)
          .eq('student_id', userProfile.id);
        
        if (data) {
          const sessions = data.map(d => d.sessions).filter(Boolean);
          setMySessions(sessions);
        }
      }
    } catch(err) {
      console.warn("Could not load user sessions:", err);
    }
  };

  // 3. Auth Actions
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg('');

    if (!email || !password) return setErrorMsg('Please fill in credentials');

    try {
      if (isSignUp) {
        if (!fullName) return setErrorMsg('Full Name is required');
        if (role === 'student' && !studentId) return setErrorMsg('Official Student ID is required');

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
              role,
              student_id: role === 'student' ? studentId : null
            }
          }
        });

        if (error) throw error;
        
        // If not in simulated mode, insert profile row explicitly (in case trigger fails)
        if (!isSimulated && data.user) {
          const { error: profileErr } = await supabase.from('profiles').insert({
            id: data.user.id,
            full_name: fullName,
            role,
            student_id: role === 'student' ? studentId : null
          });
          if (profileErr) console.warn("Profile table insert warning:", profileErr);
        }
        
        confetti({ particleCount: 60, spread: 50 });
      } else {
        // Sign In
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password
        });
        if (error) throw error;
      }
    } catch (err) {
      setErrorMsg(err.message || 'Authentication failed');
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  // Sandbox One-Click Logins for convenient local testing
  const handleSandboxLogin = async (targetRole) => {
    setErrorMsg('');
    const mockEmail = targetRole === 'teacher' ? 'teacher@activeclass.edu' : 'student@activeclass.edu';
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: mockEmail,
        password: 'password123'
      });
      if (error) throw error;
      confetti({ particleCount: 30, spread: 40, colors: ['#a855f7', '#4f46e5'] });
    } catch(err) {
      setErrorMsg(err.message || 'Sandbox authentication failed');
    }
  };

  // 4. Teacher Actions: Create Session
  const handleCreateSession = async (e) => {
    e.preventDefault();
    if (!newClassTitle.trim()) return;

    setClassroomLoading(true);
    // Generate alphanumeric uppercase unique 6-digit room code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude confusing chars like 0, O, I, 1
    let roomCode = '';
    for (let i = 0; i < 6; i++) {
      roomCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Generate 4-digit OTP key
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    try {
      const { data, error } = await supabase
        .from('sessions')
        .insert({
          teacher_id: profile.id,
          title: newClassTitle.trim(),
          room_code: roomCode,
          otp,
          status: 'active' // Starts active immediately for live streaming
        })
        .select()
        .single();

      if (error) throw error;

      // Add default whiteboard row
      await supabase.from('whiteboard_data').insert({
        session_id: data.id,
        canvas_state: []
      });

      setNewClassTitle('');
      setMySessions(prev => [data, ...prev]);
      setActiveSession(data);
      
      confetti({ particleCount: 50, spread: 45 });
    } catch (err) {
      alert("Failed to initialize session: " + err.message);
    } finally {
      setClassroomLoading(false);
    }
  };

  // 5. Student Actions: Verify and Join Classroom (Gatekeeper Flow)
  const handleJoinSession = async (e) => {
    e.preventDefault();
    setJoinError('');

    if (!joinRoomCode || !joinOtp) return setJoinError('Please fill in room code and OTP');

    try {
      // PRD Validation Routine
      const { data: session, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('room_code', joinRoomCode.toUpperCase().trim())
        .eq('status', 'active')
        .single();
      
      if (error || !session) {
        return setJoinError("Classroom code not found, or session has ended.");
      }
      
      if (session.otp !== joinOtp.trim()) {
        return setJoinError("Invalid classroom dynamic OTP key.");
      }

      // Check if student is already a participant
      const { data: existingPart } = await supabase
        .from('session_participants')
        .select('*')
        .eq('session_id', session.id)
        .eq('student_id', profile.id)
        .single();

      if (session.is_locked && !existingPart) {
        return setJoinError("This classroom is currently locked by the instructor. No new entries allowed.");
      }

      if (existingPart) {
        setActiveSession(session);
        return;
      }

      // Add student participant row
      const { error: joinErr } = await supabase
        .from('session_participants')
        .insert({
          session_id: session.id,
          student_id: profile.id,
          activities_completed: 0,
          participation_percentage: 0.00,
          is_present: false,
          manual_override: false
        });

      if (joinErr) throw joinErr;

      setActiveSession(session);
      confetti({ particleCount: 40, spread: 30, colors: ['#10b981', '#3b82f6'] });
    } catch (err) {
      setJoinError(err.message || 'Error occurred while joining classroom.');
    }
  };

  // 6. Loading screen
  if (authLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-slate-400">
        <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mb-3" />
        <span className="text-sm font-semibold tracking-wide">Loading ActiveClass Portal...</span>
      </div>
    );
  }

  // 7. Active Dashboard state routing
  if (activeSession) {
    return (
      <SessionDashboard
        session={activeSession}
        profile={profile}
        onLeave={() => {
          setActiveSession(null);
          fetchUserSessions(profile);
        }}
      />
    );
  }

  // 8. Post-Session Telemetry Report view routing
  if (reportSessionId) {
    return (
      <PostSessionReport
        sessionId={reportSessionId}
        isTeacher={profile.role === 'teacher'}
        sessionTitle={mySessions.find(s => s.id === reportSessionId)?.title || 'Class Analytics'}
        onClose={() => setReportSessionId(null)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-purple-600/30">
      
      {/* Top Banner Header */}
      <header className="px-4 py-3 sm:px-6 sm:py-4 bg-slate-900/60 border-b border-slate-800/80 flex items-center justify-between shadow-md shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg text-base shrink-0">
            A
          </div>
          <div>
            <span className="text-sm font-bold text-white">ActiveClass</span>
            <span className="text-[10px] text-slate-500 font-medium hidden sm:block -mt-0.5">Automated Attendance Analytics</span>
          </div>
        </div>

        {user && (
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="text-right max-w-[120px] sm:max-w-xs">
              <span className="text-xs font-semibold text-slate-300 block truncate">{profile?.full_name}</span>
              <span className="text-[9px] font-bold text-indigo-400 uppercase tracking-wide block truncate">
                {profile?.role === 'teacher' ? 'Instructor / Host' : `Student ID: ${profile?.student_id || 'MOCK'}`}
              </span>
            </div>
            <button
              onClick={handleSignOut}
              className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-rose-400 transition-all border border-transparent hover:border-slate-800"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
      </header>

      {/* Main Container */}
      <main className="flex-1 flex items-center justify-center p-6">
        
        {/* LOGGED OUT: AUTH PORTAL */}
        {!user ? (
          <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
            
            {/* Left side: Premium platform highlight */}
            <div className="space-y-6 order-2 md:order-1">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-purple-500/10 rounded-full border border-purple-500/20 text-purple-400 text-xs font-semibold">
                <Sparkles className="w-3.5 h-3.5" />
                Next-Gen Virtual Classrooms
              </div>
              <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white leading-tight">
                Complete Automation.<br />
                <span className="text-gradient">No Passive Absences.</span>
              </h2>
              <p className="text-slate-400 text-sm leading-relaxed max-w-md">
                ActiveClass automatically registers student attendance using real-time participation metrics. Students clearing at least 50% of active quizzes, polls, and discussions are marked present automatically.
              </p>

              {/* Features List */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-300">
                <div className="flex items-center gap-2 bg-slate-900/50 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle className="w-4 h-4 text-purple-400" />
                  <span>50% Participation Metric</span>
                </div>
                <div className="flex items-center gap-2 bg-slate-900/50 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle className="w-4 h-4 text-purple-400" />
                  <span>Vector Blackboard Sync</span>
                </div>
                <div className="flex items-center gap-2 bg-slate-900/50 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle className="w-4 h-4 text-purple-400" />
                  <span>WebRTC Video Feeds</span>
                </div>
                <div className="flex items-center gap-2 bg-slate-900/50 p-2 rounded-lg border border-slate-800/80">
                  <CheckCircle className="w-4 h-4 text-purple-400" />
                  <span>1-Click Overrides & CSV</span>
                </div>
              </div>
            </div>

            {/* Right side: Login Panel */}
            <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-6 shadow-2xl space-y-4 order-1 md:order-2">
              <div className="flex justify-between border-b border-slate-800 pb-2">
                <button
                  type="button"
                  onClick={() => setIsSignUp(false)}
                  className={`text-sm font-bold pb-2 border-b-2 transition-all ${
                    !isSignUp ? 'border-purple-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => setIsSignUp(true)}
                  className={`text-sm font-bold pb-2 border-b-2 transition-all ${
                    isSignUp ? 'border-purple-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Create Account
                </button>
              </div>

              {errorMsg && (
                <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs px-3 py-2 rounded-lg flex items-center gap-1.5">
                  <AlertCircle className="w-4 h-4" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <form onSubmit={handleAuthSubmit} className="space-y-3.5">
                {isSignUp && (
                  <>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Full Name</label>
                      <input
                        type="text"
                        value={fullName}
                        onChange={e => setFullName(e.target.value)}
                        placeholder="Dr. Sarah Connor"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500"
                        required
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">I am a</label>
                      <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 rounded-lg border border-slate-800">
                        <button
                          type="button"
                          onClick={() => setRole('student')}
                          className={`py-1.5 rounded text-xs font-bold capitalize transition-all ${
                            role === 'student' ? 'bg-purple-600 text-white' : 'text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          Student
                        </button>
                        <button
                          type="button"
                          onClick={() => setRole('teacher')}
                          className={`py-1.5 rounded text-xs font-bold capitalize transition-all ${
                            role === 'teacher' ? 'bg-purple-600 text-white' : 'text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          Teacher
                        </button>
                      </div>
                    </div>

                    {role === 'student' && (
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Student ID (University ID)</label>
                        <input
                          type="text"
                          value={studentId}
                          onChange={e => setStudentId(e.target.value)}
                          placeholder="STU-2026-98"
                          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500"
                          required
                        />
                      </div>
                    )}
                  </>
                )}

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email Address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="email@university.edu"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg text-xs font-bold shadow hover:opacity-95 transition-all pt-2.5"
                >
                  {isSignUp ? 'Register Account' : 'Access Account'}
                </button>
              </form>

              {/* Developer Test Helpers */}
              <div className="border-t border-slate-800 pt-4 text-center">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block mb-2">Sandbox One-Click Login</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSandboxLogin('teacher')}
                    className="flex-1 py-1.5 bg-slate-950 hover:bg-slate-850 border border-slate-800 text-[10px] text-indigo-400 font-bold rounded-lg transition-all"
                  >
                    Teacher Sandbox
                  </button>
                  <button
                    onClick={() => handleSandboxLogin('student')}
                    className="flex-1 py-1.5 bg-slate-950 hover:bg-slate-850 border border-slate-800 text-[10px] text-emerald-400 font-bold rounded-lg transition-all"
                  >
                    Student Sandbox
                  </button>
                </div>
              </div>
            </div>

          </div>
        ) : (
          /* LOGGED IN: CLASSROOM LOBBY */
          <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
            
            {/* Left Column: Room Entry Flow (Create/Join) */}
            <div className="md:col-span-5 space-y-6">
              
              {profile?.role === 'teacher' ? (
                /* TEACHER PANEL: CREATE ROOM */
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
                  <div className="flex items-center gap-2">
                    <Plus className="w-5 h-5 text-purple-400" />
                    <h3 className="font-bold text-slate-200 text-sm md:text-base">Initialize Secure Classroom</h3>
                  </div>

                  <form onSubmit={handleCreateSession} className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Classroom Title</label>
                      <input
                        type="text"
                        value={newClassTitle}
                        onChange={e => setNewClassTitle(e.target.value)}
                        placeholder="Introduction to Biochemistry (Lec-04)"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500"
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={classroomLoading}
                      className="w-full py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold transition-all shadow"
                    >
                      {classroomLoading ? 'Launching...' : 'Create secure room'}
                    </button>
                  </form>
                </div>
              ) : (
                /* STUDENT PANEL: JOIN ROOM */
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
                  <div className="flex items-center gap-2">
                    <Key className="w-5 h-5 text-emerald-400" />
                    <h3 className="font-bold text-slate-200 text-sm md:text-base">Join Live Classroom</h3>
                  </div>

                  {joinError && (
                    <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs px-3 py-2 rounded-lg flex items-center gap-1.5">
                      <AlertCircle className="w-4 h-4" />
                      <span>{joinError}</span>
                    </div>
                  )}

                  <form onSubmit={handleJoinSession} className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Classroom Room Code</label>
                      <input
                        type="text"
                        value={joinRoomCode}
                        onChange={e => setJoinRoomCode(e.target.value)}
                        placeholder="CHEM12"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono tracking-wider placeholder:font-sans placeholder:tracking-normal"
                        required
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Dynamic OTP Key</label>
                      <input
                        type="text"
                        value={joinOtp}
                        onChange={e => setJoinOtp(e.target.value)}
                        placeholder="4-digit numerical OTP"
                        maxLength="4"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono tracking-widest placeholder:font-sans placeholder:tracking-normal"
                        required
                      />
                    </div>

                    <button
                      type="submit"
                      className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-all shadow"
                    >
                      Authenticate & Enter
                    </button>
                  </form>
                </div>
              )}

            </div>

            {/* Right Column: Classroom Sessions list */}
            <div className="md:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 self-stretch flex flex-col">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <BookOpen className="w-5 h-5 text-indigo-400" />
                  <h3 className="font-bold text-slate-200 text-sm md:text-base">
                    {profile?.role === 'teacher' ? 'My Managed Classrooms' : 'My Registered Classrooms'}
                  </h3>
                </div>
                <span className="bg-slate-950 border border-slate-850 px-2 py-0.5 rounded text-[10px] text-slate-500 font-bold">
                  {mySessions.length} total
                </span>
              </div>

              {/* Grid Scroll Area */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-80">
                {mySessions.length === 0 ? (
                  <div className="text-center py-12 text-slate-500">
                    <LayoutGrid className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                    <p className="text-xs font-semibold">No classroom logs found</p>
                    <p className="text-[10px] text-slate-600">
                      {profile?.role === 'teacher' 
                        ? 'Fill in the form on the left to start a classroom instance.' 
                        : 'Ask your instructor for the Classroom Code and 4-digit OTP.'}
                    </p>
                  </div>
                ) : (
                  mySessions.map((sess) => {
                    const isActive = sess.status === 'active';
                    return (
                      <div
                        key={sess.id}
                        className="bg-slate-950/60 hover:bg-slate-950 border border-slate-800 hover:border-slate-700 p-4 rounded-xl transition-all duration-150 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                      >
                        <div className="space-y-1">
                          <h4 className="text-xs md:text-sm font-semibold text-slate-200 line-clamp-1">{sess.title}</h4>
                          <div className="flex items-center gap-2 text-[10px] text-slate-500 flex-wrap">
                            <span className="font-mono text-purple-400 font-bold">{sess.room_code}</span>
                            <span>•</span>
                            <span>OTP: {sess.otp}</span>
                            <span>•</span>
                            <span>{sess.total_activities} activities</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {isActive ? (
                            <button
                              onClick={() => setActiveSession(sess)}
                              className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 transition-all shadow"
                            >
                              <Video className="w-3.5 h-3.5" />
                              Join Live
                            </button>
                          ) : (
                            <button
                              onClick={() => setReportSessionId(sess.id)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold flex items-center gap-1 transition-all border border-slate-700"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              View Report
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

            </div>

          </div>
        )}

      </main>

      {/* Footer footer info */}
      <footer className="px-6 py-4 bg-slate-950/40 border-t border-slate-900 text-center text-[10px] text-slate-600 shrink-0 select-none">
        ActiveClass Room Analytics Platform © 2026. Made with Tailwind CSS & Supabase.
      </footer>

    </div>
  );
}

export default App;
