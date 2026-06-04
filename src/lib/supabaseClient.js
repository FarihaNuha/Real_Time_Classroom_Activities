import { createClient } from '@supabase/supabase-js';

const rawUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

// Sanitize URL (remove trailing slashes or /rest/v1 suffix)
let sanitizedUrl = rawUrl.trim();
if (sanitizedUrl.endsWith('/rest/v1/')) {
  sanitizedUrl = sanitizedUrl.slice(0, -9);
} else if (sanitizedUrl.endsWith('/rest/v1')) {
  sanitizedUrl = sanitizedUrl.slice(0, -8);
}
if (sanitizedUrl.endsWith('/')) {
  sanitizedUrl = sanitizedUrl.slice(0, -1);
}

export const isSimulated = !sanitizedUrl || 
                           !supabaseAnonKey || 
                           sanitizedUrl === '' || 
                           supabaseAnonKey === '' ||
                           sanitizedUrl.includes('your_supabase_project_url_here') || 
                           supabaseAnonKey.includes('your_supabase_anon_key_here');

// Real Supabase client (only initialized if credentials exist)
const realClient = isSimulated ? null : createClient(sanitizedUrl, supabaseAnonKey);

// In-Memory Simulated Database for Sandbox Offline Mode
const mockDb = {
  profiles: JSON.parse(localStorage.getItem('ac_profiles') || '[]'),
  sessions: JSON.parse(localStorage.getItem('ac_sessions') || '[]'),
  session_participants: JSON.parse(localStorage.getItem('ac_session_participants') || '[]'),
  activities: JSON.parse(localStorage.getItem('ac_activities') || '[]'),
  activity_responses: JSON.parse(localStorage.getItem('ac_activity_responses') || '[]'),
  whiteboard_data: JSON.parse(localStorage.getItem('ac_whiteboard_data') || '[]'),
  chat: JSON.parse(localStorage.getItem('ac_chat') || '[]')
};

const saveMockDb = () => {
  localStorage.setItem('ac_profiles', JSON.stringify(mockDb.profiles));
  localStorage.setItem('ac_sessions', JSON.stringify(mockDb.sessions));
  localStorage.setItem('ac_session_participants', JSON.stringify(mockDb.session_participants));
  localStorage.setItem('ac_activities', JSON.stringify(mockDb.activities));
  localStorage.setItem('ac_activity_responses', JSON.stringify(mockDb.activity_responses));
  localStorage.setItem('ac_whiteboard_data', JSON.stringify(mockDb.whiteboard_data));
  localStorage.setItem('ac_chat', JSON.stringify(mockDb.chat));
};

const syncAllFromLocalStorage = () => {
  const keys = {
    profiles: 'ac_profiles',
    sessions: 'ac_sessions',
    session_participants: 'ac_session_participants',
    activities: 'ac_activities',
    activity_responses: 'ac_activity_responses',
    whiteboard_data: 'ac_whiteboard_data',
    chat: 'ac_chat'
  };
  Object.keys(keys).forEach(table => {
    const key = keys[table];
    try {
      mockDb[table] = JSON.parse(localStorage.getItem(key) || '[]');
    } catch (e) {
      console.warn(`Failed to parse ${key} from localStorage:`, e);
    }
  });
};

// Listeners for simulated realtime subscriptions
const realtimeListeners = new Set();

// Global BroadcastChannel to synchronize simulated DB updates across tabs
let dbBroadcastChannel = null;
let dbReceiverChannel = null;

// Global cache of active BroadcastChannels to prevent GC
if (!window._activeBroadcastChannels) {
  window._activeBroadcastChannels = {};
}

const triggerRealtime = (event, table, record, broadcast = true) => {
  realtimeListeners.forEach(listener => {
    if (
      (listener.type === 'postgres_changes' || !listener.type) &&
      listener.table === table &&
      (listener.event === '*' || listener.event === event)
    ) {
      listener.callback({
        eventType: event,
        new: record,
        old: event === 'UPDATE' || event === 'DELETE' ? record : null
      });
    }
  });

  if (broadcast) {
    try {
      if (!dbBroadcastChannel) {
        dbBroadcastChannel = new BroadcastChannel('supabase-sim-db-sync');
        window._activeBroadcastChannels['supabase-sim-db-sync-sender'] = dbBroadcastChannel;
      }
      dbBroadcastChannel.postMessage({ event, table, record });
    } catch (e) {
      window.dispatchEvent(new CustomEvent('supabase-sim-db-sync', { detail: { event, table, record } }));
    }
  }
};

// Setup cross-tab sync receiver
try {
  dbReceiverChannel = new BroadcastChannel('supabase-sim-db-sync');
  window._activeBroadcastChannels['supabase-sim-db-sync-receiver'] = dbReceiverChannel;
  dbReceiverChannel.onmessage = (e) => {
    const { event, table, record } = e.data;
    syncAllFromLocalStorage();
    triggerRealtime(event, table, record, false);
  };
} catch (err) {
  window.addEventListener('supabase-sim-db-sync', (e) => {
    const { event, table, record } = e.detail;
    syncAllFromLocalStorage();
    triggerRealtime(event, table, record, false);
  });
}

// Create a simulated auth session
let mockCurrentUser = JSON.parse(localStorage.getItem('ac_current_user') || 'null');
const authListeners = new Set();

const triggerAuthChange = (event, session) => {
  authListeners.forEach(cb => cb(event, session));
};

// Automated attendance calculation in Simulated Mode
const recalculateMockAttendance = (sessionId, studentId, newResponse) => {
  // 1. Get student responses (excluding anonymous ones)
  const studentResponses = mockDb.activity_responses.filter(
    r => r.student_id === studentId && 
    !r.response?.is_anonymous &&
    mockDb.activities.find(a => a.id === r.activity_id && a.session_id === sessionId)
  );
  
  const activitiesCompleted = studentResponses.length;

  // 2. Get total activities
  const session = mockDb.sessions.find(s => s.id === sessionId);
  if (!session) return;
  const totalActivities = session.total_activities || 0;

  // 3. Calc percentage
  const percentage = totalActivities === 0 ? 0 : parseFloat(((activitiesCompleted / totalActivities) * 100).toFixed(2));

  // 4. Update participant
  const participantIndex = mockDb.session_participants.findIndex(
    p => p.session_id === sessionId && p.student_id === studentId
  );

  if (participantIndex !== -1) {
    const participant = mockDb.session_participants[participantIndex];
    participant.activities_completed = activitiesCompleted;
    participant.participation_percentage = percentage;
    
    if (!participant.manual_override) {
      participant.is_present = percentage >= 50.00;
    }
    
    saveMockDb();
    triggerRealtime('UPDATE', 'session_participants', participant);
  }
};

// Simulated Client Mock Builder
const mockClient = {
  auth: {
    signUp: async ({ email, password, options }) => {
      syncAllFromLocalStorage();
      const existingUser = mockDb.profiles.find(p => p.email === email);
      if (existingUser) return { data: null, error: { message: "User already exists" } };
      
      const id = crypto.randomUUID();
      const newProfile = {
        id,
        email,
        full_name: options?.data?.full_name || email.split('@')[0],
        role: options?.data?.role || 'student',
        student_id: options?.data?.student_id || null,
        updated_at: new Date().toISOString()
      };
      
      mockDb.profiles.push(newProfile);
      saveMockDb();
      
      mockCurrentUser = newProfile;
      localStorage.setItem('ac_current_user', JSON.stringify(mockCurrentUser));
      triggerAuthChange('SIGNED_IN', { user: mockCurrentUser });
      
      return { data: { user: mockCurrentUser }, error: null };
    },
    
    signInWithPassword: async ({ email, password }) => {
      syncAllFromLocalStorage();
      const profile = mockDb.profiles.find(p => p.email === email || p.full_name.toLowerCase() === email.toLowerCase());
      if (!profile) {
        // Create an automatic profile for easy sandbox log-in
        const id = crypto.randomUUID();
        const isTeacher = email.includes('teacher') || email.includes('admin') || email.toLowerCase() === 'teacher';
        const newProfile = {
          id,
          full_name: email.split('@')[0],
          role: isTeacher ? 'teacher' : 'student',
          student_id: isTeacher ? null : `STU-${Math.floor(1000 + Math.random() * 9000)}`,
          updated_at: new Date().toISOString()
        };
        mockDb.profiles.push(newProfile);
        saveMockDb();
        mockCurrentUser = newProfile;
        localStorage.setItem('ac_current_user', JSON.stringify(mockCurrentUser));
        triggerAuthChange('SIGNED_IN', { user: mockCurrentUser });
        return { data: { user: mockCurrentUser }, error: null };
      }
      
      mockCurrentUser = profile;
      localStorage.setItem('ac_current_user', JSON.stringify(mockCurrentUser));
      triggerAuthChange('SIGNED_IN', { user: mockCurrentUser });
      return { data: { user: mockCurrentUser }, error: null };
    },
    
    signOut: async () => {
      mockCurrentUser = null;
      localStorage.removeItem('ac_current_user');
      triggerAuthChange('SIGNED_OUT', null);
      return { error: null };
    },
    
    getSession: async () => {
      return { data: { session: mockCurrentUser ? { user: mockCurrentUser } : null }, error: null };
    },
    
    getUser: async () => {
      return { data: { user: mockCurrentUser }, error: null };
    },
    
    onAuthStateChange: (callback) => {
      authListeners.add(callback);
      // Fire initial state
      callback(mockCurrentUser ? 'SIGNED_IN' : 'SIGNED_OUT', mockCurrentUser ? { user: mockCurrentUser } : null);
      return {
        data: {
          subscription: {
            unsubscribe: () => authListeners.delete(callback)
          }
        }
      };
    }
  },
  
  from: (table) => {
    syncAllFromLocalStorage();
    return {
      select: (selectQuery = '*') => {
        let items = [...(mockDb[table] || [])];
        
        // Auto-join profiles relationship for simulation mode queries
        if (table === 'activity_responses' || table === 'session_participants' || table === 'chat') {
          items = items.map(item => {
            const profile = mockDb.profiles.find(p => p.id === item.student_id || p.id === item.sender_id);
            return {
              ...item,
              profiles: profile ? { full_name: profile.full_name, student_id: profile.student_id } : null
            };
          });
        }
        
        const builder = {
          eq: (field, value) => {
            items = items.filter(item => {
              if (item[field] === undefined) return false;
              return String(item[field]).toLowerCase() === String(value).toLowerCase();
            });
            return builder;
          },
          single: async () => {
            if (items.length === 0) return { data: null, error: { message: "No row found", code: "PGRST116" } };
            return { data: items[0], error: null };
          },
          order: (field, { ascending = true } = {}) => {
            items.sort((a, b) => {
              if (a[field] < b[field]) return ascending ? -1 : 1;
              if (a[field] > b[field]) return ascending ? 1 : -1;
              return 0;
            });
            return builder;
          },
          then: async (resolve) => {
            resolve({ data: items, error: null });
          }
        };
        return builder;
      },
      
      insert: (record) => {
        const records = Array.isArray(record) ? record : [record];
        const inserted = [];
        
        records.forEach(rec => {
          const newRec = { 
            id: rec.id || crypto.randomUUID(), 
            created_at: new Date().toISOString(),
            ...rec 
          };
          
          if (table === 'sessions') {
            if (newRec.is_locked === undefined) {
              newRec.is_locked = false;
            }
          }
          mockDb[table].push(newRec);
          inserted.push(newRec);
          saveMockDb();
          
          // Triggers simulation
          if (table === 'activities') {
            // Find session and increment total_activities
            const session = mockDb.sessions.find(s => s.id === newRec.session_id);
            if (session) {
              session.total_activities = (session.total_activities || 0) + 1;
              saveMockDb();
              triggerRealtime('UPDATE', 'sessions', session);

              // Recalculate attendance and percentages for ALL participants in this session
              const sessionParticipants = mockDb.session_participants.filter(p => p.session_id === newRec.session_id);
              sessionParticipants.forEach(p => {
                recalculateMockAttendance(newRec.session_id, p.student_id);
              });
            }
          }
          
          if (table === 'activity_responses') {
            // Get session from activity
            const activity = mockDb.activities.find(a => a.id === newRec.activity_id);
            if (activity) {
              recalculateMockAttendance(activity.session_id, newRec.student_id, newRec);
            }
          }
          
          triggerRealtime('INSERT', table, newRec);
        });
        
        const builder = {
          select: () => {
            return {
              single: async () => ({ data: inserted[0], error: null }),
              then: async (resolve) => resolve({ data: inserted, error: null })
            };
          },
          then: async (resolve) => {
            resolve({ data: Array.isArray(record) ? inserted : inserted[0], error: null });
          }
        };
        return builder;
      },
      
      update: (record) => {
        let itemsToUpdate = [];
        
        const builder = {
          eq: (field, value) => {
            mockDb[table] = mockDb[table].map(item => {
              if (item[field] !== undefined && String(item[field]).toLowerCase() === String(value).toLowerCase()) {
                const updatedItem = { ...item, ...record, updated_at: new Date().toISOString() };
                
                // Specific simulated triggers on UPDATE
                if (table === 'session_participants') {
                  // If manual_override changed from true to false, recalculate is_present
                  if (item.manual_override === true && updatedItem.manual_override === false) {
                    const session = mockDb.sessions.find(s => s.id === updatedItem.session_id);
                    const totalAct = session ? session.total_activities : 0;
                    if (totalAct === 0) {
                      updatedItem.participation_percentage = 0.00;
                      updatedItem.is_present = false;
                    } else {
                      updatedItem.participation_percentage = parseFloat(((updatedItem.activities_completed / totalAct) * 100).toFixed(2));
                      updatedItem.is_present = updatedItem.participation_percentage >= 50.00;
                    }
                  }
                }
                
                itemsToUpdate.push(updatedItem);
                return updatedItem;
              }
              return item;
            });
            saveMockDb();
            itemsToUpdate.forEach(item => triggerRealtime('UPDATE', table, item));
            return builder;
          },
          select: () => {
            return {
              single: async () => ({ data: itemsToUpdate[0], error: null }),
              then: async (resolve) => resolve({ data: itemsToUpdate, error: null })
            };
          },
          then: async (resolve) => {
            resolve({ data: itemsToUpdate, error: null });
          }
        };
        return builder;
      },
      
      upsert: (record) => {
        const records = Array.isArray(record) ? record : [record];
        const upserted = [];
        
        records.forEach(rec => {
          // Check if exists
          let index = -1;
          if (table === 'whiteboard_data') {
            index = mockDb.whiteboard_data.findIndex(w => w.session_id === rec.session_id);
          } else {
            index = mockDb[table].findIndex(item => item.id === rec.id);
          }
          
          if (index !== -1) {
            const old = mockDb[table][index];
            const updated = { ...old, ...rec, updated_at: new Date().toISOString() };
            mockDb[table][index] = updated;
            upserted.push(updated);
            triggerRealtime('UPDATE', table, updated);
          } else {
            const newRec = {
              id: rec.id || crypto.randomUUID(),
              created_at: new Date().toISOString(),
              ...rec
            };
            mockDb[table].push(newRec);
            upserted.push(newRec);
            triggerRealtime('INSERT', table, newRec);
          }
        });
        
        saveMockDb();
        
        const builder = {
          select: () => {
            return {
              single: async () => ({ data: upserted[0], error: null }),
              then: async (resolve) => resolve({ data: upserted, error: null })
            };
          },
          then: async (resolve) => {
            resolve({ data: Array.isArray(record) ? upserted : upserted[0], error: null });
          }
        };
        return builder;
      },
      
      delete: () => {
        let deletedItems = [];
        const builder = {
          eq: (field, value) => {
            const beforeLen = mockDb[table].length;
            deletedItems = mockDb[table].filter(item => String(item[field]).toLowerCase() === String(value).toLowerCase());
            mockDb[table] = mockDb[table].filter(item => String(item[field]).toLowerCase() !== String(value).toLowerCase());
            
            if (mockDb[table].length !== beforeLen) {
              saveMockDb();
              deletedItems.forEach(item => triggerRealtime('DELETE', table, item));
            }
            return builder;
          },
          then: async (resolve) => {
            resolve({ data: deletedItems, error: null });
          }
        };
        return builder;
      }
    };
  },
  
  channel: (channelName) => {
    const channelSubscribers = [];
    
    const chan = {
      on: (type, filter, callback) => {
        const listenerObj = {
          type,
          channelName,
          event: filter.event || '*',
          table: filter.table,
          callback
        };
        realtimeListeners.add(listenerObj);
        channelSubscribers.push(listenerObj);
        return chan;
      },
      subscribe: (statusCallback) => {
        if (statusCallback) setTimeout(() => statusCallback('SUBSCRIBED'), 50);
        
        // Setup listener and bind BroadcastChannel to channel instance to prevent GC collection
        try {
          chan._bc = new BroadcastChannel(`supabase-sim-${channelName}`);
          window._activeBroadcastChannels[`supabase-sim-${channelName}`] = chan._bc;
          chan._bc.onmessage = (event) => handleBroadcast(event.data);
        } catch(e) {
          const listener = (event) => handleBroadcast(event.detail);
          window.addEventListener(`supabase-sim-${channelName}`, listener);
          chan._listener = listener;
        }
        return chan;
      },
      send: (payload) => {
        // Broadcast custom events across tabs via localstorage event or broadcastchannel
        try {
          if (chan._bc) {
            chan._bc.postMessage(payload);
          } else {
            const bc = new BroadcastChannel(`supabase-sim-${channelName}`);
            bc.postMessage(payload);
            setTimeout(() => {
              try { bc.close(); } catch(e){}
            }, 250);
          }
        } catch(e) {
          // Fallback if BroadcastChannel fails
          window.dispatchEvent(new CustomEvent(`supabase-sim-${channelName}`, { detail: payload }));
        }
        return { error: null };
      },
      unsubscribe: () => {
        channelSubscribers.forEach(listener => realtimeListeners.delete(listener));
        if (chan._bc) {
          try {
            chan._bc.close();
          } catch(e){}
          delete window._activeBroadcastChannels[`supabase-sim-${channelName}`];
        }
        if (chan._listener) {
          window.removeEventListener(`supabase-sim-${channelName}`, chan._listener);
        }
      }
    };
    
    // Setup listener for broadcast messages
    const handleBroadcast = (data) => {
      // Find broadcast receivers
      realtimeListeners.forEach(listener => {
        if (
          listener.channelName === channelName &&
          listener.type === 'broadcast' &&
          (listener.event === '*' || listener.event === data.event)
        ) {
          listener.callback(data);
        }
      });
    };
    
    return chan;
  }
};

export const supabase = isSimulated ? mockClient : realClient;
