import React, { useRef, useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { Palette, Trash2, Undo, Circle, Eraser, Download, Activity } from 'lucide-react';

export default function Whiteboard({ sessionId, isTeacher }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  
  const [color, setColor] = useState('#a855f7'); // default violet
  const [brushSize, setBrushSize] = useState(4);
  const [tool, setTool] = useState('pen'); // 'pen', 'eraser'
  const [pages, setPages] = useState([[]]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Synced'); // 'Synced' | 'Saving...' | 'Error'

  // Colors Palette
  const colors = [
    { name: 'Purple', hex: '#a855f7' },
    { name: 'Indigo', hex: '#6366f1' },
    { name: 'Pink', hex: '#ec4899' },
    { name: 'Cyan', hex: '#06b6d4' },
    { name: 'Emerald', hex: '#10b981' },
    { name: 'Amber', hex: '#f59e0b' },
    { name: 'Rose', hex: '#f43f5e' },
    { name: 'White', hex: '#ffffff' }
  ];

  // 1. Resize and Draw Canvas when strokes update
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height || 500; // fallback height
      
      redrawCanvas();
    };

    window.addEventListener('resize', handleResize);
    // Let layout load, then resize
    const timer = setTimeout(handleResize, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timer);
    };
  }, [pages, currentPageIndex]);

  // Redraws the canvas using relative coordinates mapping to the actual width/height
  const redrawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Fill background dark slate
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw grid lines for premium blackboard feel
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < canvas.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Draw strokes for current page
    const pageStrokes = pages[currentPageIndex] || [];
    pageStrokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length < 2) return;
      
      ctx.beginPath();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke.tool === 'eraser' ? '#0f172a' : stroke.color;
      ctx.lineWidth = stroke.size;

      // Map relative coordinates to absolute screen pixels
      const startX = stroke.points[0].x * canvas.width;
      const startY = stroke.points[0].y * canvas.height;
      ctx.moveTo(startX, startY);

      for (let i = 1; i < stroke.points.length; i++) {
        const x = stroke.points[i].x * canvas.width;
        const y = stroke.points[i].y * canvas.height;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
  };

  // Helper to load canvas state and support backward compatibility
  const handleLoadState = (rawState) => {
    const state = typeof rawState === 'string'
      ? JSON.parse(rawState)
      : rawState;
    
    if (Array.isArray(state)) {
      // Legacy single-page format
      setPages([state]);
      setCurrentPageIndex(0);
    } else if (state && Array.isArray(state.pages)) {
      setPages(state.pages);
      setCurrentPageIndex(state.currentPageIndex || 0);
    } else {
      setPages([[]]);
      setCurrentPageIndex(0);
    }
  };

  // 2. Student Subscription Setup
  useEffect(() => {
    if (isTeacher) return;

    // Fetch initial board state
    const fetchWhiteboard = async () => {
      try {
        const { data, error } = await supabase
          .from('whiteboard_data')
          .select('canvas_state')
          .eq('session_id', sessionId)
          .single();
        
        if (data && data.canvas_state) {
          handleLoadState(data.canvas_state);
        }
      } catch (err) {
        console.warn("Could not load initial whiteboard:", err);
      }
    };

    fetchWhiteboard();

    // Listen to real-time database updates
    const subscription = supabase
      .channel(`whiteboard-changes-${sessionId}`)
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'whiteboard_data',
        filter: `session_id=eq.${sessionId}` 
      }, payload => {
        if (payload.new && payload.new.canvas_state) {
          handleLoadState(payload.new.canvas_state);
          setLastSyncTime(new Date().toLocaleTimeString());
        }
      })
      .on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: 'whiteboard_data',
        filter: `session_id=eq.${sessionId}` 
      }, payload => {
        if (payload.new && payload.new.canvas_state) {
          handleLoadState(payload.new.canvas_state);
          setLastSyncTime(new Date().toLocaleTimeString());
        }
      })
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [sessionId, isTeacher]);

  // 3. Teacher Debounced Auto-Sync (Every 1000ms)
  useEffect(() => {
    if (!isTeacher || !hasUnsavedChanges) return;

    const syncTimer = setTimeout(async () => {
      setSyncStatus('Saving...');
      setIsSyncing(true);
      try {
        const { error } = await supabase
          .from('whiteboard_data')
          .upsert({
            session_id: sessionId,
            canvas_state: {
              currentPageIndex,
              pages
            },
            updated_at: new Date().toISOString()
          }, { onConflict: 'session_id' });

        if (error) {
          console.error("Whiteboard sync error:", error);
          setSyncStatus('Error');
        } else {
          setSyncStatus('Synced');
          setHasUnsavedChanges(false);
          setLastSyncTime(new Date().toLocaleTimeString());
        }
      } catch (err) {
        console.error("Whiteboard sync crash:", err);
        setSyncStatus('Error');
      } finally {
        setIsSyncing(false);
      }
    }, 1000);

    return () => clearTimeout(syncTimer);
  }, [pages, currentPageIndex, hasUnsavedChanges, sessionId, isTeacher]);

  // 4. Drawing Input Event Handlers (Teacher only)
  const getCoordinates = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    
    // Handle touch vs mouse
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    // Absolute position on canvas
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    // Convert to relative percentage coordinates (0.0 to 1.0)
    return {
      x: x / canvas.width,
      y: y / canvas.height
    };
  };

  const handleStartDraw = (e) => {
    if (!isTeacher) return;
    e.preventDefault();
    const coords = getCoordinates(e);
    if (!coords) return;

    setIsDrawing(true);
    
    const newStroke = {
      tool,
      color,
      size: tool === 'eraser' ? brushSize * 4 : brushSize,
      points: [coords]
    };
    
    setPages((prev) => {
      const nextPages = [...prev];
      if (!nextPages[currentPageIndex]) {
        nextPages[currentPageIndex] = [];
      }
      nextPages[currentPageIndex] = [...nextPages[currentPageIndex], newStroke];
      return nextPages;
    });
    setHasUnsavedChanges(true);
    setSyncStatus('Saving...');
  };

  const handleDrawing = (e) => {
    if (!isTeacher || !isDrawing) return;
    e.preventDefault();
    const coords = getCoordinates(e);
    if (!coords) return;

    setPages((prev) => {
      const nextPages = [...prev];
      const pageStrokes = nextPages[currentPageIndex] || [];
      if (pageStrokes.length === 0) return prev;
      
      const lastStroke = { ...pageStrokes[pageStrokes.length - 1] };
      lastStroke.points = [...lastStroke.points, coords];
      
      nextPages[currentPageIndex] = [...pageStrokes.slice(0, -1), lastStroke];
      return nextPages;
    });
    setHasUnsavedChanges(true);
  };

  const handleEndDraw = () => {
    if (!isTeacher) return;
    setIsDrawing(false);
  };

  // Drawing Controls
  const handleUndo = () => {
    if (!isTeacher) return;
    const pageStrokes = pages[currentPageIndex] || [];
    if (pageStrokes.length === 0) return;
    
    setPages((prev) => {
      const nextPages = [...prev];
      nextPages[currentPageIndex] = pageStrokes.slice(0, -1);
      return nextPages;
    });
    setHasUnsavedChanges(true);
    setSyncStatus('Saving...');
  };

  const handleClear = () => {
    if (!isTeacher || !window.confirm('Clear current whiteboard page?')) return;
    setPages((prev) => {
      const nextPages = [...prev];
      nextPages[currentPageIndex] = [];
      return nextPages;
    });
    setHasUnsavedChanges(true);
    setSyncStatus('Saving...');
  };

  // Page switching & creation actions
  const handleAddPage = () => {
    if (!isTeacher) return;
    setPages((prev) => [...prev, []]);
    setCurrentPageIndex((prev) => prev + 1);
    setHasUnsavedChanges(true);
    setSyncStatus('Saving...');
  };

  const handlePrevPage = () => {
    if (currentPageIndex > 0) {
      setCurrentPageIndex((prev) => prev - 1);
      // Student is auto-navigated on sync, teacher updates the index state
      setHasUnsavedChanges(true);
      setSyncStatus('Saving...');
    }
  };

  const handleNextPage = () => {
    if (currentPageIndex < pages.length - 1) {
      setCurrentPageIndex((prev) => prev + 1);
      setHasUnsavedChanges(true);
      setSyncStatus('Saving...');
    }
  };

  // Export board as PNG
  const handleExport = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const link = document.createElement('a');
    link.download = `whiteboard-${sessionId}-page-${currentPageIndex + 1}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-purple-500/10 text-purple-400">
            <Activity className="w-4 h-4 animate-pulse-ring" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-200 text-sm md:text-base">Smart Whiteboard</h3>
            <p className="text-xs text-slate-400">
              {isTeacher ? 'Broadcasting live drawing coordinates' : 'Live read-only projection stream'}
            </p>
          </div>
        </div>

        {/* Page Nav controls */}
        <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg p-1">
          <button
            onClick={handlePrevPage}
            disabled={currentPageIndex === 0}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded disabled:opacity-30 disabled:hover:bg-transparent transition-all font-bold animate-fade-in"
            title="Previous Page"
          >
            &lt; Prev
          </button>
          <span className="text-xs text-purple-400 font-bold px-1.5 font-mono">
            Page {currentPageIndex + 1} / {pages.length}
          </span>
          <button
            onClick={handleNextPage}
            disabled={currentPageIndex === pages.length - 1}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded disabled:opacity-30 disabled:hover:bg-transparent transition-all font-bold animate-fade-in"
            title="Next Page"
          >
            Next &gt;
          </button>
          {isTeacher && (
            <button
              onClick={handleAddPage}
              className="ml-1 px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs font-bold transition-all shadow"
              title="Add a new blank notebook page"
            >
              + Add Page
            </button>
          )}
        </div>
        
        {/* Sync telemetry */}
        <div className="flex items-center gap-3 text-xs">
          {lastSyncTime && (
            <span className="text-slate-500 hidden md:inline">Last sync: {lastSyncTime}</span>
          )}
          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full font-medium ${
            syncStatus === 'Synced' ? 'bg-emerald-500/10 text-emerald-400' :
            syncStatus === 'Saving...' ? 'bg-amber-500/10 text-amber-400 animate-pulse' :
            'bg-rose-500/10 text-rose-400'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              syncStatus === 'Synced' ? 'bg-emerald-400' :
              syncStatus === 'Saving...' ? 'bg-amber-400' : 'bg-rose-400'
            }`} />
            {syncStatus}
          </span>
        </div>
      </div>

      {/* Drawing board core */}
      <div 
        ref={containerRef} 
        className="relative flex-1 bg-slate-950 cursor-crosshair overflow-hidden min-h-[400px]"
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleStartDraw}
          onMouseMove={handleDrawing}
          onMouseUp={handleEndDraw}
          onMouseLeave={handleEndDraw}
          onTouchStart={handleStartDraw}
          onTouchMove={handleDrawing}
          onTouchEnd={handleEndDraw}
          className="absolute inset-0 block w-full h-full"
        />

        {!isTeacher && (pages[currentPageIndex] || []).length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/80 text-slate-400 p-6 pointer-events-none text-center">
            <div className="w-12 h-12 rounded-full border-2 border-dashed border-slate-700 flex items-center justify-center mb-3 animate-spin">
              <Circle className="w-4 h-4 text-purple-400" />
            </div>
            <p className="font-semibold text-slate-300">Whiteboard is empty</p>
            <p className="text-xs text-slate-500 max-w-xs mt-1">Waiting for the instructor to start drawing and push live coordinate vectors.</p>
          </div>
        )}
      </div>

      {/* Footer controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-950 border-t border-slate-800">
        {isTeacher ? (
          <>
            {/* Left controls: tool switcher & brush sizes */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5">
                <button
                  onClick={() => setTool('pen')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1 transition-all ${
                    tool === 'pen' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Palette className="w-3.5 h-3.5" />
                  Pen
                </button>
                <button
                  onClick={() => setTool('eraser')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1 transition-all ${
                    tool === 'eraser' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5" />
                  Eraser
                </button>
              </div>

              {/* Color selections */}
              {tool === 'pen' && (
                <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1">
                  {colors.map((c) => (
                    <button
                      key={c.hex}
                      onClick={() => setColor(c.hex)}
                      title={c.name}
                      style={{ backgroundColor: c.hex }}
                      className={`w-5 h-5 rounded-full transition-all border ${
                        color === c.hex ? 'border-white scale-125 shadow-md shadow-white/20' : 'border-slate-800 hover:scale-110'
                      }`}
                    />
                  ))}
                </div>
              )}

              {/* Brush sizes */}
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5">
                {[2, 4, 8, 16].map((size) => (
                  <button
                    key={size}
                    onClick={() => setBrushSize(size)}
                    title={`Size ${size}px`}
                    className={`w-6 h-6 rounded flex items-center justify-center transition-all ${
                      brushSize === size ? 'bg-slate-800 text-purple-400 font-bold' : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <span 
                      style={{ width: `${Math.max(2, size / 1.5)}px`, height: `${Math.max(2, size / 1.5)}px` }} 
                      className="rounded-full bg-current"
                    />
                  </button>
                ))}
              </div>
            </div>

            {/* Right controls: actions */}
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={handleUndo}
                disabled={(pages[currentPageIndex] || []).length === 0}
                className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-900 rounded-lg border border-slate-800 disabled:opacity-40 disabled:hover:bg-transparent transition-all"
                title="Undo stroke"
              >
                <Undo className="w-4 h-4" />
              </button>
              <button
                onClick={handleClear}
                disabled={(pages[currentPageIndex] || []).length === 0}
                className="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-950/20 rounded-lg border border-slate-800 disabled:opacity-40 disabled:hover:bg-transparent transition-all"
                title="Clear Board"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={handleExport}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-900 rounded-lg border border-slate-800 transition-all flex items-center gap-1.5 text-xs font-medium"
                title="Export Board to PNG"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Export PNG</span>
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between w-full">
            <span className="text-xs text-slate-500">Board mode: Live sync viewing</span>
            <button
              onClick={handleExport}
              className="px-3 py-1.5 text-slate-400 hover:text-white hover:bg-slate-900 rounded-lg border border-slate-800 transition-all flex items-center gap-1.5 text-xs font-medium"
              title="Download Board Capture"
            >
              <Download className="w-4 h-4" />
              Download Capture
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
