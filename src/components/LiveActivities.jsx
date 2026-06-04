import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { Plus, BarChart2, CheckCircle2, MessageSquare, Award, Clock, HelpCircle, X, Check } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function LiveActivities({ sessionId, isTeacher, currentStudentId, participants = [], profile }) {
  // Activity state
  const [activeActivity, setActiveActivity] = useState(null);
  const [activityHistory, setActivityHistory] = useState([]);
  const [responses, setResponses] = useState([]); // for teachers: active activity responses
  const [myResponse, setMyResponse] = useState(null); // for students: student's own response
  
  // Custom teacher/student states
  const [teacherSubTab, setTeacherSubTab] = useState('activity'); // 'activity' | 'leaderboard' | 'history'
  const [isAnonymous, setIsAnonymous] = useState(false);
  
  // Builder state
  const [showBuilder, setShowBuilder] = useState(false);
  const [type, setType] = useState('poll'); // 'poll', 'quiz', 'q_and_a'
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [correctOptionIndex, setCorrectOptionIndex] = useState(0);

  // 1. Listeners and Data Loading
  useEffect(() => {
    // Load initial activities
    const loadActivities = async () => {
      try {
        const { data, error } = await supabase
          .from('activities')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: false });

        if (data && data.length > 0) {
          setActivityHistory(data);
          const active = data.find(a => a.status === 'active');
          if (active) {
            setActiveActivity(active);
            if (isTeacher) {
              fetchResponses(active.id);
            } else {
              fetchMyResponse(active.id);
            }
          }
        }
      } catch (err) {
        console.warn("Could not load initial activities:", err);
      }
    };

    loadActivities();

    // Subscribe to new/updated activities
    const channel = supabase
      .channel(`activities-realtime-${sessionId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'activities',
        filter: `session_id=eq.${sessionId}`
      }, payload => {
        if (payload.eventType === 'INSERT') {
          const newAct = payload.new;
          setActiveActivity(newAct);
          setActivityHistory(prev => [newAct, ...prev]);
          setMyResponse(null);
          setResponses([]);
          
          if (!isTeacher) {
            // Trigger student notification / popup
            triggerActivityAlert();
          }
        } else if (payload.eventType === 'UPDATE') {
          const updated = payload.new;
          setActivityHistory(prev => prev.map(a => a.id === updated.id ? updated : a));
          if (activeActivity && activeActivity.id === updated.id) {
            setActiveActivity(updated);
            if (updated.status === 'closed') {
              setActiveActivity(null);
            }
          }
        }
      })
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [sessionId, isTeacher, currentStudentId]);

  // 2. Fetch responses for the active activity (Teacher only)
  useEffect(() => {
    if (!isTeacher || !activeActivity) return;

    // Fetch initial responses
    fetchResponses(activeActivity.id);

    // Listen for responses in real time and refresh responses list
    const resChannel = supabase
      .channel(`activity-responses-realtime-${activeActivity.id}`);

    // Direct Broadcast listener for instant cross-tab responses
    resChannel.on('broadcast', { event: 'new-response' }, ({ payload }) => {
      setResponses(prev => {
        if (prev.find(r => r.id === payload.id)) return prev;
        return [...prev, payload];
      });
    });

    resChannel.on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'activity_responses',
      filter: `activity_id=eq.${activeActivity.id}`
    }, payload => {
      fetchResponses(activeActivity.id);
    });

    resChannel.subscribe();

    return () => {
      resChannel.unsubscribe();
    };
  }, [activeActivity, isTeacher]);

  const fetchResponses = async (activityId) => {
    const { data } = await supabase
      .from('activity_responses')
      .select(`
        id,
        activity_id,
        student_id,
        response,
        submitted_at,
        profiles (full_name, student_id)
      `)
      .eq('activity_id', activityId);
    if (data) setResponses(data);
  };



  const fetchMyResponse = async (activityId) => {
    if (!currentStudentId) return;
    const { data } = await supabase
      .from('activity_responses')
      .select(`
        id,
        activity_id,
        student_id,
        response,
        submitted_at
      `)
      .eq('activity_id', activityId)
      .eq('student_id', currentStudentId)
      .single();
    if (data) setMyResponse(data);
  };

  // Student animation trigger
  const triggerActivityAlert = () => {
    // We can play an alert tone or pulse the UI
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
      gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.15);
    } catch(e) {}
  };

  // 3. Teacher Actions: Create & Launch Activity
  const handleLaunch = async () => {
    if (!question.trim()) return alert('Please enter a question');
    if (type !== 'q_and_a' && options.some(opt => !opt.trim())) {
      return alert('Please fill in all options');
    }

    const payloadContent = {
      question: question.trim(),
      options: type !== 'q_and_a' ? options.filter(o => o.trim()) : [],
      correctIndex: type === 'quiz' ? correctOptionIndex : null
    };

    try {
      // Close active first
      if (activeActivity) {
        await supabase
          .from('activities')
          .update({ status: 'closed' })
          .eq('id', activeActivity.id);
      }

      const { data, error } = await supabase
        .from('activities')
        .insert({
          session_id: sessionId,
          type,
          content: payloadContent,
          status: 'active'
        })
        .select()
        .single();

      if (error) throw error;
      
      // Reset builder
      setQuestion('');
      setOptions(['', '']);
      setShowBuilder(false);
    } catch (err) {
      alert("Failed to launch activity: " + err.message);
    }
  };

  const handleCloseActivity = async (activityId) => {
    try {
      await supabase
        .from('activities')
        .update({ status: 'closed' })
        .eq('id', activityId);
      setActiveActivity(null);
    } catch (err) {
      console.error(err);
    }
  };

  // Builder option managers
  const addOption = () => {
    if (options.length < 6) setOptions([...options, '']);
  };

  const removeOption = (idx) => {
    if (options.length > 2) {
      const next = [...options];
      next.splice(idx, 1);
      setOptions(next);
      if (correctOptionIndex >= next.length) {
        setCorrectOptionIndex(next.length - 1);
      }
    }
  };

  const updateOption = (idx, text) => {
    const next = [...options];
    next[idx] = text;
    setOptions(next);
  };

  // 4. Student Actions: Submit Response
  const handleSubmitResponse = async (answer) => {
    if (!activeActivity || myResponse) return;

    const payloadResponse = {
      value: answer,
      is_anonymous: isAnonymous
    };

    try {
      const { data, error } = await supabase
        .from('activity_responses')
        .insert({
          activity_id: activeActivity.id,
          student_id: currentStudentId,
          response: payloadResponse
        })
        .select()
        .single();

      if (error) throw error;
      
      setMyResponse(data);

      // Broadcast response to teacher instantly
      try {
        const resChannel = supabase.channel(`activity-responses-realtime-${activeActivity.id}`);
        resChannel.send({
          type: 'broadcast',
          event: 'new-response',
          payload: {
            id: data.id,
            activity_id: activeActivity.id,
            student_id: currentStudentId,
            response: payloadResponse,
            submitted_at: data.submitted_at,
            profiles: {
              full_name: isAnonymous ? 'Anonymous Student' : (profile?.full_name || 'Student'),
              student_id: isAnonymous ? null : (profile?.student_id || 'STU-MOCK')
            }
          }
        });
      } catch (err) {
        console.warn("Could not broadcast response:", err);
      }
      
      // Confetti effect on correct quiz response
      if (activeActivity.type === 'quiz') {
        const correctIndex = activeActivity.content.correctIndex;
        const correctText = activeActivity.content.options[correctIndex];
        if (String(answer).toLowerCase() === String(correctText).toLowerCase()) {
          confetti({ particleCount: 80, spread: 60, origin: { y: 0.8 } });
        }
      } else {
        // Normal success feedback
        confetti({ particleCount: 30, spread: 40, colors: ['#a855f7', '#6366f1'], origin: { y: 0.8 } });
      }
    } catch (err) {
      alert("Failed to submit response: " + err.message);
    }
  };

  // Real-time chart renderer values calculation
  const getPollStats = (activity) => {
    const stats = {};
    if (!activity || !activity.content || !activity.content.options) return stats;
    
    activity.content.options.forEach(opt => {
      stats[opt] = 0;
    });

    const activeResponses = isTeacher ? responses : []; // can only draw full bars if teacher, or we can fetch totals
    // Wait, let's calculate from responses state
    responses.forEach(r => {
      const val = r.response?.value;
      if (val !== undefined && stats[val] !== undefined) {
        stats[val]++;
      }
    });

    const total = responses.length || 1;
    return Object.keys(stats).map(key => ({
      label: key,
      count: stats[key],
      percentage: Math.round((stats[key] / total) * 100)
    }));
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
      {/* Sidebar Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-indigo-400" />
          <h3 className="font-semibold text-slate-200 text-sm">Interactive Room Activities</h3>
        </div>
        {isTeacher && !showBuilder && (
          <button
            onClick={() => setShowBuilder(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            Launch
          </button>
        )}
      </div>

      {isTeacher && (
        <div className="flex bg-slate-950 border-b border-slate-800 p-1 text-[11px] shrink-0">
          <button
            onClick={() => setTeacherSubTab('activity')}
            className={`flex-1 py-1.5 text-center font-bold rounded transition-all ${
              teacherSubTab === 'activity' ? 'bg-slate-900 text-purple-400 font-bold' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Active Module
          </button>
          <button
            onClick={() => setTeacherSubTab('leaderboard')}
            className={`flex-1 py-1.5 text-center font-bold rounded transition-all ${
              teacherSubTab === 'leaderboard' ? 'bg-slate-900 text-indigo-400 font-bold' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Engagement Analytics
          </button>
          <button
            onClick={() => setTeacherSubTab('history')}
            className={`flex-1 py-1.5 text-center font-bold rounded transition-all ${
              teacherSubTab === 'history' ? 'bg-slate-900 text-pink-400 font-bold' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            History ({activityHistory.length})
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isTeacher ? (
          /* TEACHER PANEL CONTENT */
          <>
            {teacherSubTab === 'activity' && (
              <>
                {showBuilder ? (
                  /* TEACHER BUILDER PANEL */
                  <div className="bg-slate-950 p-4 border border-slate-800 rounded-lg space-y-3 animate-fade-in-up">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">New Activity Builder</span>
                      <button 
                        onClick={() => setShowBuilder(false)}
                        className="text-slate-500 hover:text-slate-300"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Type selector */}
                    <div className="grid grid-cols-3 gap-2 bg-slate-900 p-0.5 rounded-lg border border-slate-800 text-xs">
                      {['poll', 'quiz', 'q_and_a'].map(t => (
                        <button
                          key={t}
                          onClick={() => setType(t)}
                          className={`py-1.5 rounded-md font-semibold capitalize transition-all ${
                            type === t ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {t.replace('_', ' ')}
                        </button>
                      ))}
                    </div>

                    {/* Question description */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-slate-400">Question Text</label>
                      <textarea
                        value={question}
                        onChange={e => setQuestion(e.target.value)}
                        placeholder="What is the output of...?"
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        rows="2"
                      />
                    </div>

                    {/* Option fields (Poll and Quiz only) */}
                    {type !== 'q_and_a' && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-[11px] font-bold text-slate-400">Options & Correct Selection</label>
                          {options.length < 6 && (
                            <button onClick={addOption} className="text-[10px] text-purple-400 hover:underline">
                              + Add Option
                            </button>
                          )}
                        </div>

                        <div className="space-y-2">
                          {options.map((opt, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              {type === 'quiz' && (
                                <button
                                  type="button"
                                  onClick={() => setCorrectOptionIndex(idx)}
                                  className={`w-5 h-5 rounded-full border flex items-center justify-center transition-all ${
                                    correctOptionIndex === idx 
                                      ? 'bg-emerald-500 border-emerald-400 text-white' 
                                      : 'border-slate-700 hover:border-slate-500 text-transparent'
                                  }`}
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                              )}
                              <input
                                type="text"
                                value={opt}
                                onChange={e => updateOption(idx, e.target.value)}
                                placeholder={`Option ${idx + 1}`}
                                className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                              />
                              {options.length > 2 && (
                                <button 
                                  onClick={() => removeOption(idx)}
                                  className="text-slate-500 hover:text-rose-400"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleLaunch}
                      className="w-full py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg text-xs font-semibold shadow hover:opacity-95 transition-all mt-2"
                    >
                      Push & Launch to Room
                    </button>
                  </div>
                ) : activeActivity ? (
                  /* TEACHER LIVE CHART RESULTS */
                  <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-4 animate-fade-in-up">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="flex h-2 w-2 relative">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                        </span>
                        <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Live Activity</span>
                      </div>
                      <button
                        onClick={() => handleCloseActivity(activeActivity.id)}
                        className="px-2 py-0.5 border border-slate-800 hover:bg-slate-900 text-slate-400 rounded-md text-[10px] transition-all"
                      >
                        Close Activity
                      </button>
                    </div>

                    <div className="space-y-1">
                      <p className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                        {activeActivity.type.replace('_', ' ')}
                      </p>
                      <h4 className="text-sm font-semibold text-slate-100">{activeActivity.content?.question}</h4>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>Submissions: {responses.length}</span>
                        <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-purple-400" /> Live updates</span>
                      </div>

                      {activeActivity.type === 'q_and_a' ? (
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {responses.length === 0 ? (
                            <p className="text-xs text-slate-500 text-center py-4">Waiting for responses...</p>
                          ) : (
                            responses.map((r) => (
                              <div key={r.id} className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg text-xs">
                                <p className="text-slate-300">{r.response?.value}</p>
                                <span className="text-[10px] text-slate-500 mt-1 block font-medium">
                                  Answered by {r.response?.is_anonymous ? 'Anonymous Student' : (r.profiles?.full_name || 'Student')}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      ) : (
                        <div className="space-y-3 bg-slate-900/50 p-3 rounded-lg border border-slate-800/60">
                          {getPollStats(activeActivity).map((stat, i) => {
                            const isCorrect = activeActivity.type === 'quiz' && stat.label === activeActivity.content.options[activeActivity.content.correctIndex];
                            return (
                              <div key={i} className="space-y-1">
                                <div className="flex items-center justify-between text-xs font-medium">
                                  <span className={`flex items-center gap-1.5 ${isCorrect ? 'text-emerald-400 font-bold' : 'text-slate-300'}`}>
                                    {isCorrect && <Check className="w-3.5 h-3.5" />}
                                    {stat.label}
                                  </span>
                                  <span className="text-slate-400">{stat.count} ({stat.percentage}%)</span>
                                </div>
                                <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                  <div
                                    style={{ width: `${stat.percentage}%` }}
                                    className={`h-full rounded-full transition-all duration-500 ${
                                      isCorrect ? 'bg-emerald-500' : 'bg-indigo-500'
                                    }`}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Responders List */}
                      <div className="border-t border-slate-800 pt-3 space-y-2">
                        <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">Responders & Submissions</span>
                        {responses.length === 0 ? (
                          <p className="text-[10px] text-slate-600 italic">No responses recorded yet.</p>
                        ) : (
                          <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                            {responses.map((r) => {
                              const name = r.response?.is_anonymous 
                                ? 'Anonymous Student' 
                                : (r.profiles?.full_name || 'Anonymous Student');
                              const stuId = r.response?.is_anonymous 
                                ? 'Hidden' 
                                : (r.profiles?.student_id || 'STU-MOCK');
                              
                              return (
                                <div key={r.id} className="flex justify-between items-center bg-slate-900 border border-slate-850 px-2.5 py-1.5 rounded text-[11px]">
                                  <div className="flex flex-col">
                                    <span className="font-semibold text-slate-300">{name}</span>
                                    <span className="text-[9px] text-slate-500 font-mono">{stuId}</span>
                                  </div>
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                    r.response?.is_anonymous 
                                      ? 'bg-slate-950 text-slate-500 border border-slate-850' 
                                      : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                                  }`}>
                                    {r.response?.value}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                    </div>
                  </div>
                ) : (
                  /* NO ACTIVE ACTIVITY PLACEHOLDER */
                  <div className="flex flex-col items-center justify-center p-6 text-center text-slate-500 h-64">
                    <HelpCircle className="w-8 h-8 text-slate-700 mb-2" />
                    <p className="text-xs font-semibold text-slate-400">No active activity</p>
                    <p className="text-[10px] text-slate-600 max-w-xs mt-1">
                      Click "Launch" in the top right to start a Poll, Quiz, or Q&A and push it live to students.
                    </p>
                  </div>
                )}
              </>
            )}

            {teacherSubTab === 'leaderboard' && (
              /* ENGAGEMENT TELEMETRY GRAPH */
              <div className="space-y-3 bg-slate-950 p-4 border border-slate-800 rounded-xl animate-fade-in-up">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider block">Student Engagement leaderboard</span>
                <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {participants.length === 0 ? (
                    <p className="text-xs text-slate-500 text-center py-6">No student records found yet.</p>
                  ) : (
                    [...participants].sort((a, b) => b.percentage - a.percentage).map((p, idx) => (
                      <div key={p.id} className="space-y-1.5 p-2 bg-slate-900/50 border border-slate-850 rounded-lg">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-semibold text-slate-200">
                            {idx + 1}. {p.fullName} <span className="text-[10px] text-slate-500 font-mono">({p.universityId})</span>
                          </span>
                          <span className={`font-mono font-bold text-[10px] px-1.5 py-0.5 rounded ${p.percentage >= 50 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                            {p.percentage}% ({p.isPresent ? 'Present' : 'Absent'})
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-955 border border-slate-850 rounded-full overflow-hidden">
                          <div 
                            style={{ width: `${p.percentage}%` }}
                            className={`h-full rounded-full transition-all duration-300 ${
                              p.percentage >= 50 ? 'bg-emerald-500' : 'bg-rose-500'
                            }`}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {teacherSubTab === 'history' && (
              /* SESSION HISTORY */
              <div className="space-y-2 bg-slate-950 p-4 border border-slate-800 rounded-xl animate-fade-in-up">
                <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Session History ({activityHistory.length})</h4>
                {activityHistory.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-6">No previous activities recorded.</p>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                    {activityHistory.map((act) => (
                      <div key={act.id} className="bg-slate-900 border border-slate-850 p-3 rounded-lg text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-indigo-400 capitalize">{act.type.replace('_', ' ')}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                            act.status === 'active' ? 'bg-red-500/10 text-red-400 animate-pulse' : 'bg-slate-800 text-slate-500'
                          }`}>
                            {act.status}
                          </span>
                        </div>
                        <p className="font-medium text-slate-300">{act.content?.question}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          /* STUDENT PANEL CONTENT */
          <>
            {activeActivity ? (
              <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl space-y-4 animate-fade-in-up">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                    </span>
                    <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Live Activity</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-slate-400 uppercase tracking-wider font-bold">
                    {activeActivity.type.replace('_', ' ')}
                  </p>
                  <h4 className="text-sm font-semibold text-slate-100">{activeActivity.content?.question}</h4>
                </div>

                <div className="space-y-3">
                  {myResponse ? (
                    <div className="flex flex-col items-center justify-center p-6 bg-slate-900 rounded-lg border border-slate-850 text-center space-y-2">
                      <CheckCircle2 className="w-8 h-8 text-emerald-400 animate-bounce" />
                      <h5 className="font-semibold text-slate-200 text-sm">Response Submitted</h5>
                      <p className="text-xs text-slate-400">
                        Your answer: <span className="text-indigo-400 font-bold">{myResponse.response?.value}</span>
                        {myResponse.response?.is_anonymous && (
                          <span className="text-[10px] text-amber-400 font-bold block mt-1">Submitted Anonymously (Attendance not counted)</span>
                        )}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-1">
                        {myResponse.response?.is_anonymous 
                          ? 'Anonymous questions and answers do not count towards the 50% participation attendance score.'
                          : 'Your participation score has been automatically updated in real-time.'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Anonymous toggle checkbox */}
                      <div className="flex items-center gap-2 px-1.5 py-1 text-slate-400">
                        <input 
                          type="checkbox" 
                          id="anonymous-submit"
                          checked={isAnonymous}
                          onChange={(e) => setIsAnonymous(e.target.checked)}
                          className="rounded border-slate-800 bg-slate-900 text-purple-600 focus:ring-purple-500 h-3.5 w-3.5"
                        />
                        <label htmlFor="anonymous-submit" className="text-[10px] select-none font-medium text-slate-400">
                          Answer anonymously (Attendance & participation will NOT be counted)
                        </label>
                      </div>

                      {activeActivity.type === 'q_and_a' ? (
                        <form onSubmit={(e) => {
                          e.preventDefault();
                          const val = e.target.qText.value;
                          if (val.trim()) handleSubmitResponse(val.trim());
                        }} className="space-y-2">
                          <textarea
                            name="qText"
                            placeholder="Type your answer here..."
                            className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            rows="3"
                            required
                          />
                          <button
                            type="submit"
                            className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold shadow transition-all"
                          >
                            Submit Answer
                          </button>
                        </form>
                      ) : (
                        <div className="space-y-2">
                          {activeActivity.content?.options?.map((opt, i) => (
                            <button
                              key={i}
                              onClick={() => handleSubmitResponse(opt)}
                              className="w-full text-left px-4 py-3 bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-slate-750 rounded-lg text-xs text-slate-200 font-medium transition-all hover:scale-[1.01] flex items-center justify-between"
                            >
                              <span>{opt}</span>
                              <span className="w-5 h-5 rounded-full border border-slate-700 flex items-center justify-center text-[10px] text-slate-500">
                                {String.fromCharCode(65 + i)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-6 text-center text-slate-500 h-64 bg-slate-950 border border-slate-800 rounded-xl">
                <HelpCircle className="w-8 h-8 text-slate-700 mb-2" />
                <p className="text-xs font-semibold text-slate-400">No active activity</p>
                <p className="text-[10px] text-slate-600 max-w-xs mt-1">
                  Waiting for the teacher to launch a quiz or interactive question module.
                </p>
              </div>
            )}

            {/* Student Session History */}
            {activityHistory.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-800/50">
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Session History ({activityHistory.length})</h4>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                  {activityHistory.map((act) => (
                    <div key={act.id} className="bg-slate-950/40 border border-slate-800/60 p-3 rounded-lg text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-indigo-400 capitalize">{act.type.replace('_', ' ')}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                          act.status === 'active' ? 'bg-red-500/10 text-red-400 animate-pulse' : 'bg-slate-800 text-slate-500'
                        }`}>
                          {act.status}
                        </span>
                      </div>
                      <p className="font-medium text-slate-300">{act.content?.question}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
