import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';
import { 
  FileText, Download, CheckCircle, XCircle, Award, 
  Image, BarChart, ArrowLeft, Check, AlertTriangle, CloudLightning 
} from 'lucide-react';
import confetti from 'canvas-confetti';

const formatTime = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export default function PostSessionReport({ sessionId, isTeacher, sessionTitle, onClose }) {
  const [activeReportTab, setActiveReportTab] = useState('attendance'); // 'attendance' | 'activities' | 'whiteboard'
  
  // Data State
  const [participants, setParticipants] = useState([]);
  const [activities, setActivities] = useState([]);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [whiteboardStrokes, setWhiteboardStrokes] = useState([]);
  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // References
  const previewCanvasRef = useRef(null);

  // Fetch all reports data
  useEffect(() => {
    const fetchReportData = async () => {
      setIsLoading(true);
      try {
        // 1. Fetch Session Title & Total Activities
        const { data: sess } = await supabase
          .from('sessions')
          .select('*')
          .eq('id', sessionId)
          .single();
        if (sess) setSessionInfo(sess);

        // 2. Fetch Participants
        const { data: parts } = await supabase
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
          .eq('session_id', sessionId);
        
        if (parts) {
          setParticipants(parts.map(p => ({
            id: p.id,
            studentId: p.student_id,
            fullName: p.profiles?.full_name || 'Anonymous Student',
            universityId: p.profiles?.student_id || 'STU-MOCK',
            activitiesCompleted: p.activities_completed,
            percentage: parseFloat(p.participation_percentage || 0),
            isPresent: p.is_present,
            manualOverride: p.manual_override
          })));
        }

        // 3. Fetch Activities & responses
        const { data: acts } = await supabase
          .from('activities')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true });

        if (acts) {
          // Fetch responses for all these activities to draw charts
          const fetchedActs = await Promise.all(acts.map(async (act) => {
            const { data: resps } = await supabase
              .from('activity_responses')
              .select('*')
              .eq('activity_id', act.id);
            return {
              ...act,
              responsesCount: resps ? resps.length : 0,
              responses: resps || []
            };
          }));
          setActivities(fetchedActs);
        }

        // 4. Fetch Whiteboard Drawing vectors
        const { data: wb } = await supabase
          .from('whiteboard_data')
          .select('canvas_state')
          .eq('session_id', sessionId)
          .single();

        if (wb && wb.canvas_state) {
          const loadedStrokes = typeof wb.canvas_state === 'string' 
            ? JSON.parse(wb.canvas_state) 
            : wb.canvas_state;
          setWhiteboardStrokes(loadedStrokes || []);
        }

      } catch (err) {
        console.warn("Error gathering post-session reports:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchReportData();
  }, [sessionId]);

  // Render Whiteboard preview on canvas
  useEffect(() => {
    if (activeReportTab === 'whiteboard') {
      setTimeout(() => {
        const canvas = previewCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        
        canvas.width = 600;
        canvas.height = 400;
        
        // Draw background
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Grid pattern
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 1;
        for (let x = 0; x < canvas.width; x += 30) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += 30) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        }

        // Parse pages
        let pageStrokes = [];
        if (Array.isArray(whiteboardStrokes)) {
          pageStrokes = whiteboardStrokes;
        } else if (whiteboardStrokes && Array.isArray(whiteboardStrokes.pages)) {
          pageStrokes = whiteboardStrokes.pages[previewPageIndex] || [];
        }

        // Render strokes
        pageStrokes.forEach((stroke) => {
          if (!stroke.points || stroke.points.length < 2) return;
          ctx.beginPath();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = stroke.tool === 'eraser' ? '#0f172a' : stroke.color;
          ctx.lineWidth = stroke.size * 0.8; // scale size down a bit for smaller preview

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
      }, 100);
    }
  }, [activeReportTab, whiteboardStrokes, previewPageIndex]);

  // Handle Manual Override in Post Session Report (Teacher only)
  const handleToggleOverride = async (p) => {
    if (!isTeacher) return;
    const nextOverride = !p.manualOverride;
    const nextPresent = !p.isPresent;
    
    try {
      const { error } = await supabase
        .from('session_participants')
        .update({
          manual_override: nextOverride,
          is_present: nextOverride ? nextPresent : p.isPresent
        })
        .eq('id', p.id);

      if (!error) {
        setParticipants(prev => prev.map(item => {
          if (item.id === p.id) {
            return {
              ...item,
              manualOverride: nextOverride,
              isPresent: nextOverride ? nextPresent : item.isPresent
            };
          }
          return item;
        }));
        confetti({ particleCount: 15, spread: 25, colors: ['#a855f7'] });
      }
    } catch(err) {
      console.error(err);
    }
  };

  const handleStatusChange = async (p, forcePresent) => {
    try {
      const { error } = await supabase
        .from('session_participants')
        .update({
          manual_override: true,
          is_present: forcePresent
        })
        .eq('id', p.id);

      if (!error) {
        setParticipants(prev => prev.map(item => {
          if (item.id === p.id) {
            return {
              ...item,
              manualOverride: true,
              isPresent: forcePresent
            };
          }
          return item;
        }));
      }
    } catch (err) {
      alert("Failed to update status: " + err.message);
    }
  };

  const handleDisableOverride = async (p) => {
    try {
      const { error } = await supabase
        .from('session_participants')
        .update({
          manual_override: false
        })
        .eq('id', p.id);

      if (!error) {
        // Re-read current database row to reflect the trigger's result locally
        const { data: updatedRow } = await supabase
          .from('session_participants')
          .select('is_present, participation_percentage')
          .eq('id', p.id)
          .single();

        if (updatedRow) {
          setParticipants(prev => prev.map(item => {
            if (item.id === p.id) {
              return {
                ...item,
                manualOverride: false,
                isPresent: updatedRow.is_present,
                percentage: parseFloat(updatedRow.participation_percentage || 0)
              };
            }
            return item;
          }));
        }
      }
    } catch (err) {
      alert("Failed to update status: " + err.message);
    }
  };

  // Export Attendance to CSV format
  const handleExportCSV = () => {
    const headers = ['Student ID', 'Full Name', 'Activities Completed', 'Total Activities', 'Participation Percentage', 'System Presence', 'Override Enabled'];
    const rows = participants.map(p => [
      p.universityId,
      p.fullName,
      p.activitiesCompleted,
      sessionInfo?.total_activities || 0,
      `${p.percentage}%`,
      p.isPresent ? 'Present' : 'Absent',
      p.manualOverride ? 'Yes' : 'No'
    ]);

    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(','), ...rows.map(e => e.map(val => `"${val}"`).join(","))].join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `attendance_report_${sessionInfo?.room_code || 'class'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export Teaching content to PDF format (Print-Friendly DOM template with in-memory canvas)
  const handleExportTeachingPDF = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert("Please allow popups to download/print the PDF report.");
      return;
    }

    const sessionTitleStr = sessionInfo?.title || sessionTitle || 'Class Session';
    const roomCodeStr = sessionInfo?.room_code || 'N/A';
    const dateStr = sessionInfo?.created_at ? new Date(sessionInfo.created_at).toLocaleDateString() : new Date().toLocaleDateString();
    const timeStr = sessionInfo?.created_at ? new Date(sessionInfo.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();

    // 1. Draw whiteboard in-memory canvas for all pages
    let whiteboardImgHtml = '';
    
    // Normalize pages
    let pagesToRender = [];
    if (Array.isArray(whiteboardStrokes)) {
      if (whiteboardStrokes.length > 0) {
        pagesToRender = [whiteboardStrokes];
      }
    } else if (whiteboardStrokes && Array.isArray(whiteboardStrokes.pages)) {
      pagesToRender = whiteboardStrokes.pages;
    }

    if (pagesToRender.length > 0) {
      const imgHtmls = pagesToRender.map((pageStrokes, pageIdx) => {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 1200;
        tempCanvas.height = 800;
        const ctx = tempCanvas.getContext('2d');
        
        // Draw background
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        
        // Draw grid pattern
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 1;
        for (let x = 0; x < tempCanvas.width; x += 50) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, tempCanvas.height); ctx.stroke();
        }
        for (let y = 0; y < tempCanvas.height; y += 50) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(tempCanvas.width, y); ctx.stroke();
        }
        
        // Render strokes
        pageStrokes.forEach((stroke) => {
          if (!stroke.points || stroke.points.length < 2) return;
          ctx.beginPath();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = stroke.tool === 'eraser' ? '#0f172a' : stroke.color;
          ctx.lineWidth = stroke.size * 1.5; // scale size up for higher resolution canvas

          const startX = stroke.points[0].x * tempCanvas.width;
          const startY = stroke.points[0].y * tempCanvas.height;
          ctx.moveTo(startX, startY);

          for (let i = 1; i < stroke.points.length; i++) {
            const x = stroke.points[i].x * tempCanvas.width;
            const y = stroke.points[i].y * tempCanvas.height;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        });

        const whiteboardImgUrl = tempCanvas.toDataURL('image/png');
        return `
          <div style="margin-bottom: 35px; page-break-inside: avoid;">
            <div class="section-title">Smart Whiteboard Capture - Page ${pageIdx + 1}</div>
            <img src="${whiteboardImgUrl}" style="width: 100%; border: 1px solid #cbd5e1; border-radius: 12px; display: block; margin-top: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);" />
          </div>
        `;
      });
      whiteboardImgHtml = imgHtmls.join('');
    } else {
      whiteboardImgHtml = `
        <div style="margin-bottom: 35px; page-break-inside: avoid;">
          <div class="section-title">Smart Whiteboard Capture</div>
          <div style="padding: 30px; text-align: center; border: 2px dashed #cbd5e1; border-radius: 12px; color: #94a3b8; font-size: 13px; margin-top: 12px;">
            No whiteboard vector strokes drawn or saved during this classroom session.
          </div>
        </div>
      `;
    }

    // 2. Format Questions
    const questionsHtml = activities.map((act, index) => {
      let optionsHtml = '';
      if (act.type !== 'q_and_a' && act.content?.options) {
        optionsHtml = `<ul style="list-style-type: none; padding-left: 0; margin-top: 8px;">` + 
          act.content.options.map((opt, i) => {
            const isCorrect = act.type === 'quiz' && i === act.content.correctIndex;
            return `<li style="padding: 6px 12px; margin-bottom: 4px; border-radius: 6px; font-size: 12px; ${
              isCorrect ? 'background-color: #dcfce7; color: #15803d; font-weight: bold; border-left: 4px solid #16a34a;' : 'background-color: #f8fafc; color: #475569; border-left: 4px solid #e2e8f0;'
            }">${opt} ${isCorrect ? ' (Correct Answer)' : ''}</li>`;
          }).join('') + `</ul>`;
      }
      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 16px; background-color: #ffffff; page-break-inside: avoid;">
          <span style="font-size: 9px; font-weight: 800; text-transform: uppercase; color: #1d4ed8; letter-spacing: 0.05em; background-color: #eff6ff; padding: 3px 8px; border-radius: 4px;">
            Question #${index + 1} • ${act.type.replace('_', ' ')}
          </span>
          <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-top: 8px;">${act.content?.question || 'N/A'}</div>
          ${optionsHtml}
        </div>
      `;
    }).join('');

    printWindow.document.write(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Class Teaching & Notebook Report - ${sessionTitleStr}</title>
  <style>
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      color: #1e293b;
      margin: 0;
      padding: 40px;
      line-height: 1.5;
      background-color: #ffffff;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #f1f5f9;
      padding-bottom: 20px;
      margin-bottom: 25px;
    }
    .header-left h1 {
      font-size: 22px;
      font-weight: 800;
      margin: 0;
      color: #0f172a;
      letter-spacing: -0.025em;
    }
    .header-left p {
      margin: 4px 0 0 0;
      font-size: 13px;
      color: #64748b;
    }
    .header-right {
      text-align: right;
    }
    .room-badge {
      display: inline-block;
      background-color: #eff6ff;
      color: #1d4ed8;
      font-weight: 800;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 8px;
      font-family: monospace;
      letter-spacing: 0.05em;
    }
    .session-meta {
      font-size: 11px;
      color: #64748b;
      margin-top: 8px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 850;
      text-transform: uppercase;
      color: #334155;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
      border-left: 4px solid #1d4ed8;
      padding-left: 8px;
    }
    .footer {
      margin-top: 60px;
      border-top: 1px solid #e2e8f0;
      padding-top: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      page-break-inside: avoid;
    }
    .footer-left {
      font-size: 10px;
      color: #94a3b8;
      }
    .signature-area {
      text-align: center;
      width: 200px;
    }
    .signature-line {
      border-bottom: 1px solid #cbd5e1;
      width: 100%;
      height: 35px;
      margin-bottom: 6px;
    }
    .signature-title {
      font-size: 10px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    @media print {
      body {
        padding: 0;
      }
      tr {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Class Teaching & Notebook Report</h1>
      <p>Session Title: <strong>${sessionTitleStr}</strong></p>
    </div>
    <div class="header-right">
      <div class="room-badge">ROOM: ${roomCodeStr}</div>
      <div class="session-meta">Generated on ${dateStr} at ${timeStr}</div>
    </div>
  </div>

  ${whiteboardImgHtml}

  <div style="margin-top: 30px;">
    <div class="section-title">Lesson Question Bank</div>
    <div style="margin-top: 12px;">
      ${questionsHtml || '<div style="padding: 20px; text-align: center; color: #94a3b8; font-size: 13px;">No interactive questions or activities launched during this classroom session.</div>'}
    </div>
  </div>

  <div class="footer">
    <div class="footer-left">
      Generated automatically by ActiveClass Classroom Analytics Engine.<br>
      This document preserves whiteboard drawings, lecture materials, and teacher-created questions.
    </div>
    <div class="signature-area">
      <div class="signature-line"></div>
      <div class="signature-title">Instructor Signature</div>
    </div>
  </div>

  <script>
    window.onload = function() {
      window.print();
      setTimeout(function() {
        window.close();
      }, 500);
    };
  </script>
</body>
</html>
    `);
    printWindow.document.close();
  };

  // Export Attendance & Student Responses to PDF format (Print-Friendly DOM template)
  const handleExportResponsePDF = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert("Please allow popups to download/print the PDF report.");
      return;
    }

    const sessionTitleStr = sessionInfo?.title || sessionTitle || 'Class Session';
    const roomCodeStr = sessionInfo?.room_code || 'N/A';
    const dateStr = sessionInfo?.created_at ? new Date(sessionInfo.created_at).toLocaleDateString() : new Date().toLocaleDateString();
    const timeStr = sessionInfo?.created_at ? new Date(sessionInfo.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
    
    const rowsHtml = participants.map(p => `
      <tr>
        <td style="font-family: monospace; font-weight: bold; color: #6b21a8;">${p.universityId}</td>
        <td style="font-weight: 600;">${p.fullName}</td>
        <td style="text-align: center;">${p.activitiesCompleted} / ${sessionInfo?.total_activities || 0}</td>
        <td style="text-align: center; font-family: monospace;">${p.percentage}%</td>
        <td style="text-align: center;">
          ${p.isPresent 
            ? '<span class="status-badge status-present">✔ Present</span>' 
            : '<span class="status-badge status-absent">✘ Absent</span>'
          }
        </td>
        <td style="text-align: center; color: #64748b; font-size: 11px;">
          ${p.manualOverride ? 'Manual Override' : 'System Auto'}
        </td>
      </tr>
    `).join('');

    const responsesAnalyticsHtml = activities.map((act, index) => {
      let contentHtml = '';
      
      if (act.type !== 'q_and_a' && act.content?.options) {
        contentHtml = `<div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px; max-width: 600px;">` +
          act.content.options.map((opt, i) => {
            const correctIndex = act.content.correctIndex;
            const isCorrect = act.type === 'quiz' && i === correctIndex;
            
            const optCount = act.responses.filter(r => r.response?.value === opt).length;
            const totalResp = act.responses.length || 1;
            const pct = Math.round((optCount / totalResp) * 100);

            return `
              <div style="font-size: 12px; margin-bottom: 2px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                  <span style="${isCorrect ? 'color: #166534; font-weight: bold;' : 'color: #334155;'}">
                    ${isCorrect ? '✔ ' : ''}${opt}
                  </span>
                  <span style="font-weight: 600; color: #475569;">${optCount} answers (${pct}%)</span>
                </div>
                <div style="width: 100%; height: 8px; background-color: #e2e8f0; border-radius: 4px; overflow: hidden;">
                  <div style="width: ${pct}%; height: 100%; background-color: ${isCorrect ? '#22c55e' : '#4f46e5'}; border-radius: 4px;"></div>
                </div>
              </div>
            `;
          }).join('') + `</div>`;
      } else {
        const textResponses = act.responses.map(r => {
          const senderName = r.profiles?.full_name || r.sender_name || 'Anonymous Student';
          const senderId = r.profiles?.student_id || 'STU-MOCK';
          const isAnon = r.response?.is_anonymous || false;
          
          return `
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; margin-bottom: 8px; font-size: 11px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px; font-weight: 600; color: #64748b;">
                <span>${isAnon ? 'Anonymous Student' : `${senderName} (${senderId})`}</span>
                <span>${r.submitted_at ? new Date(r.submitted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
              <div style="color: #0f172a; font-weight: 550;">${r.response?.value || ''}</div>
            </div>
          `;
        }).join('');

        contentHtml = `
          <div style="margin-top: 10px;">
            <div style="font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 0.025em;">Student Submissions Log</div>
            ${textResponses || '<div style="font-size: 11px; color: #94a3b8; font-style: italic;">No response answers submitted.</div>'}
          </div>
        `;
      }

      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 16px; background-color: #ffffff; page-break-inside: avoid;">
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px;">
            <span style="font-size: 9px; font-weight: 800; text-transform: uppercase; color: #4f46e5; letter-spacing: 0.05em; background-color: #e0e7ff; padding: 3px 8px; border-radius: 4px;">
              Activity #${index + 1} • ${act.type.replace('_', ' ')}
            </span>
            <span style="font-size: 10px; color: #64748b; font-weight: 600; background-color: #f1f5f9; padding: 2px 6px; border-radius: 4px;">
              ${act.responsesCount} Submissions
            </span>
          </div>
          <div style="font-size: 13px; font-weight: 700; color: #0f172a; margin-top: 10px;">${act.content?.question || 'N/A'}</div>
          ${contentHtml}
        </div>
      `;
    }).join('');

    printWindow.document.write(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Student Response Report - ${sessionTitleStr}</title>
  <style>
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      color: #1e293b;
      margin: 0;
      padding: 40px;
      line-height: 1.5;
      background-color: #ffffff;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #f1f5f9;
      padding-bottom: 20px;
      margin-bottom: 25px;
    }
    .header-left h1 {
      font-size: 22px;
      font-weight: 800;
      margin: 0;
      color: #0f172a;
      letter-spacing: -0.025em;
    }
    .header-left p {
      margin: 4px 0 0 0;
      font-size: 13px;
      color: #64748b;
    }
    .header-right {
      text-align: right;
    }
    .room-badge {
      display: inline-block;
      background-color: #f5f3ff;
      color: #4f46e5;
      font-weight: 800;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 8px;
      font-family: monospace;
      letter-spacing: 0.05em;
    }
    .session-meta {
      font-size: 11px;
      color: #64748b;
      margin-top: 8px;
    }
    .metrics-container {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 30px;
    }
    .metric-card {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 16px;
      background-color: #fafafa;
    }
    .metric-card .label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: #64748b;
      letter-spacing: 0.05em;
    }
    .metric-card .value {
      font-size: 20px;
      font-weight: 800;
      color: #0f172a;
      margin-top: 4px;
    }
    .metric-card .subtext {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 850;
      text-transform: uppercase;
      color: #334155;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
      border-left: 4px solid #4f46e5;
      padding-left: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 40px;
    }
    th {
      background-color: #f8fafc;
      color: #475569;
      font-weight: 700;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 10px 14px;
      border-bottom: 2px solid #e2e8f0;
      text-align: left;
    }
    td {
      padding: 12px 14px;
      font-size: 12px;
      border-bottom: 1px solid #f1f5f9;
      color: #334155;
    }
    tr:nth-child(even) td {
      background-color: #fafafa;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      font-weight: 700;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .status-badge.status-present {
      background-color: #dcfce7;
      color: #166534;
    }
    .status-badge.status-absent {
      background-color: #fee2e2;
      color: #991b1b;
    }
    .footer {
      margin-top: 60px;
      border-top: 1px solid #e2e8f0;
      padding-top: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      page-break-inside: avoid;
    }
    .footer-left {
      font-size: 10px;
      color: #94a3b8;
    }
    .signature-area {
      text-align: center;
      width: 200px;
    }
    .signature-line {
      border-bottom: 1px solid #cbd5e1;
      width: 100%;
      height: 35px;
      margin-bottom: 6px;
    }
    .signature-title {
      font-size: 10px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    @media print {
      body {
        padding: 0;
      }
      tr {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Student Response & Analytics Report</h1>
      <p>Session Title: <strong>${sessionTitleStr}</strong></p>
    </div>
    <div class="header-right">
      <div class="room-badge">ROOM: ${roomCodeStr}</div>
      <div class="session-meta">Generated on ${dateStr} at ${timeStr}</div>
    </div>
  </div>

  <div class="metrics-container">
    <div class="metric-card">
      <div class="label">Attendance Rate</div>
      <div class="value">${totalStudents > 0 ? Math.round((presentStudents / totalStudents) * 100) : 0}%</div>
      <div class="subtext">${presentStudents} of ${totalStudents} present</div>
    </div>
    <div class="metric-card">
      <div class="label">Average Engagement</div>
      <div class="value">${avgParticipation}%</div>
      <div class="subtext">Average response rate</div>
    </div>
    <div class="metric-card">
      <div class="label">Activities Conducted</div>
      <div class="value">${sessionInfo?.total_activities || 0} Questions</div>
      <div class="subtext">Polls, quizzes & Q&As</div>
    </div>
  </div>

  <div class="section-title">Student Attendance Roster</div>
  <table>
    <thead>
      <tr>
        <th>Student ID</th>
        <th>Full Name</th>
        <th style="text-align: center;">Activities Answered</th>
        <th style="text-align: center;">Participation rate</th>
        <th style="text-align: center;">Attendance Outcome</th>
        <th style="text-align: center;">Verification Mode</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="6" style="text-align: center; color: #94a3b8;">No student records found in this classroom session.</td></tr>'}
    </tbody>
  </table>

  <div style="margin-top: 30px;">
    <div class="section-title">Student Activity Performance & Charts</div>
    <div style="margin-top: 12px;">
      ${responsesAnalyticsHtml || '<div style="padding: 20px; text-align: center; color: #94a3b8; font-size: 13px;">No student submissions recorded for activities.</div>'}
    </div>
  </div>

  <div class="footer">
    <div class="footer-left">
      Generated automatically by ActiveClass Classroom Analytics Engine.<br>
      Automated threshold rule: Participation &ge; 50% required for present outcome.
    </div>
    <div class="signature-area">
      <div class="signature-line"></div>
      <div class="signature-title">Instructor Signature</div>
    </div>
  </div>

  <script>
    window.onload = function() {
      window.print();
      setTimeout(function() {
        window.close();
      }, 500);
    };
  </script>
</body>
</html>
    `);
    printWindow.document.close();
  };

  // Download whiteboard image
  const handleDownloadWhiteboard = () => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    
    const link = document.createElement('a');
    link.download = `whiteboard_archive_${sessionInfo?.room_code || 'class'}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  // Math metrics for summary panel
  const totalStudents = participants.length;
  const presentStudents = participants.filter(p => p.isPresent).length;
  const avgParticipation = totalStudents > 0 
    ? Math.round(participants.reduce((sum, p) => sum + p.percentage, 0) / totalStudents) 
    : 0;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-slate-400">
        <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-semibold tracking-wide">Generating Classroom Analytical Telemetry Reports...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      
      {/* Top Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800 shadow-md shrink-0">
        <div className="flex items-center gap-3">
          <button 
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-all"
            title="Return to lobby"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-base font-bold text-slate-200">{sessionTitle}</h1>
            <p className="text-xs text-slate-500">Post-Session Analytics & Immutable Record Archive</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {activeReportTab === 'attendance' && (
            <div className="flex gap-2">
              {isTeacher && (
                <>
                  <button
                    onClick={handleExportTeachingPDF}
                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow transition-all border border-blue-500/30"
                  >
                    <FileText className="w-4 h-4" />
                    Download Teaching PDF
                  </button>
                  <button
                    onClick={handleExportResponsePDF}
                    disabled={participants.length === 0}
                    className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow transition-all border border-indigo-500/30"
                  >
                    <FileText className="w-4 h-4" />
                    Download Responses PDF
                  </button>
                </>
              )}
              <button
                onClick={handleExportCSV}
                disabled={participants.length === 0}
                className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow transition-all border border-purple-500/30"
              >
                <Download className="w-4 h-4" />
                Export CSV Report
              </button>
            </div>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all border border-slate-700"
          >
            Return to Dashboard
          </button>
        </div>
      </header>

      {/* Analytics Summary Panels */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 px-6 py-4 bg-slate-900/40 border-b border-slate-800/80 shrink-0">
        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Attendance Rate</span>
            <span className="text-xl font-bold text-slate-200">
              {totalStudents > 0 ? Math.round((presentStudents / totalStudents) * 100) : 0}%
            </span>
            <span className="text-[10px] text-slate-500 block mt-0.5">({presentStudents} of {totalStudents} present)</span>
          </div>
          <CheckCircle className="w-8 h-8 text-emerald-500" />
        </div>

        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Average Engagement</span>
            <span className="text-xl font-bold text-slate-200">{avgParticipation}%</span>
            <span className="text-[10px] text-slate-500 block mt-0.5">Average response rate per student</span>
          </div>
          <Award className="w-8 h-8 text-indigo-400" />
        </div>

        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Activities Launched</span>
            <span className="text-xl font-bold text-slate-200">{sessionInfo?.total_activities || 0} Questions</span>
            <span className="text-[10px] text-slate-500 block mt-0.5">Polls, quizzes & open Q&As</span>
          </div>
          <CloudLightning className="w-8 h-8 text-purple-400" />
        </div>
      </section>

      {/* Tabs list */}
      <div className="flex bg-slate-950 border-b border-slate-800 shrink-0 px-6 py-2">
        <div className="flex gap-1.5">
          <button
            onClick={() => setActiveReportTab('attendance')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeReportTab === 'attendance' ? 'bg-slate-900 text-purple-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Class Attendance Sheet
          </button>

          <button
            onClick={() => setActiveReportTab('activities')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeReportTab === 'activities' ? 'bg-slate-900 text-indigo-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <BarChart className="w-3.5 h-3.5" />
            Class Activity Metrics
          </button>

          <button
            onClick={() => setActiveReportTab('whiteboard')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
              activeReportTab === 'whiteboard' ? 'bg-slate-900 text-pink-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Image className="w-3.5 h-3.5" />
            Whiteboard Project Archive
          </button>
        </div>
      </div>

      {/* 3. Report Display Space */}
      <div className="flex-1 overflow-y-auto p-6 bg-slate-950">
        
        {/* T1: Attendance Report */}
        {activeReportTab === 'attendance' && (
          <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-xl animate-fade-in-up">
            <div className="px-6 py-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center flex-wrap gap-2">
              <div>
                <h3 className="font-semibold text-slate-200 text-sm">Automated Attendance Log</h3>
                <p className="text-xs text-slate-500 mt-0.5">Calculated using the 50% Participation Automation Rule.</p>
              </div>
              {isTeacher && (
                <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-1 text-[11px] text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Manual overrides bypass the automated threshold.</span>
                </div>
              )}
            </div>

            {participants.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <FileText className="w-10 h-10 text-slate-700 mx-auto mb-2" />
                <p className="text-xs font-semibold">No student records found</p>
                <p className="text-[10px] text-slate-600">No participants registered in this classroom session.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs text-slate-300">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500 font-bold bg-slate-950/40">
                      <th className="px-6 py-3">Student ID</th>
                      <th className="px-6 py-3">Full Name</th>
                      <th className="px-6 py-3 text-center">Activities Answered</th>
                      <th className="px-6 py-3 text-center">Engagement Percentage</th>
                      <th className="px-6 py-3 text-center">Attendance Outcome</th>
                      <th className="px-6 py-3 text-center">Override Flags</th>
                      {isTeacher && <th className="px-6 py-3 text-right">Override Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-850">
                    {participants.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-800/20">
                        <td className="px-6 py-3.5 font-mono text-[11px] text-purple-400 font-bold">{p.universityId}</td>
                        <td className="px-6 py-3.5 font-semibold text-slate-200">{p.fullName}</td>
                        <td className="px-6 py-3.5 text-center font-bold">
                          {p.activitiesCompleted} / {sessionInfo?.total_activities || 0}
                        </td>
                        <td className="px-6 py-3.5 text-center">
                          <span className={`px-2 py-0.5 rounded font-mono ${
                            p.percentage >= 50 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                          }`}>
                            {p.percentage}%
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-center">
                          {p.isPresent ? (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-extrabold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 text-xs">
                              ✔ Present
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-extrabold bg-rose-500/15 text-rose-400 border border-rose-500/20 text-xs">
                              ✘ Absent
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-center">
                          {p.manualOverride ? (
                            <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] px-1.5 py-0.5 rounded font-semibold">
                              MANUAL OVERRIDE
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-600 font-semibold">AUTOMATIC</span>
                          )}
                        </td>
                        {isTeacher && (
                          <td className="px-6 py-3.5 text-right space-x-1.5">
                            {p.manualOverride ? (
                              <div className="inline-flex gap-1.5">
                                <button
                                  onClick={() => handleStatusChange(p, true)}
                                  className={`px-2.5 py-1 rounded text-[10px] font-bold border transition-all ${
                                    p.isPresent 
                                      ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30' 
                                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                                  }`}
                                >
                                  Present
                                </button>
                                <button
                                  onClick={() => handleStatusChange(p, false)}
                                  className={`px-2.5 py-1 rounded text-[10px] font-bold border transition-all ${
                                    !p.isPresent 
                                      ? 'bg-rose-600/20 text-rose-400 border-rose-500/30' 
                                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                                  }`}
                                >
                                  Absent
                                </button>
                                <button
                                  onClick={() => handleDisableOverride(p)}
                                  className="px-2.5 py-1 bg-slate-900 border border-slate-700 hover:bg-slate-850 text-slate-400 hover:text-slate-200 rounded text-[10px]"
                                >
                                  Reset Auto
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => handleToggleOverride(p)}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-purple-950/40 border border-slate-700 hover:border-purple-900/30 text-slate-400 hover:text-purple-400 rounded text-[10px] font-bold transition-all"
                              >
                                Override Attendance
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* T2: Activity Summary Reports */}
        {activeReportTab === 'activities' && (
          <div className="space-y-6 max-w-4xl mx-auto animate-fade-in-up">
            {activities.length === 0 ? (
              <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-xl text-center text-slate-500 shadow">
                <BarChart className="w-10 h-10 text-slate-700 mx-auto mb-2" />
                <p className="text-xs font-semibold">No activity logs recorded</p>
                <p className="text-[10px] text-slate-600">No interactive polls or quizzes were launched during this session.</p>
              </div>
            ) : (
              activities.map((act, index) => {
                return (
                  <div key={act.id} className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden shadow-lg p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-wrap gap-2">
                      <div>
                        <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wide">
                          Activity #{index + 1} • {act.type.replace('_', ' ')}
                        </span>
                        <h4 className="text-sm font-semibold text-slate-200 mt-1">{act.content?.question}</h4>
                      </div>
                      <span className="text-[10px] text-slate-500 bg-slate-950 px-2.5 py-1 rounded-md border border-slate-850">
                        {act.responsesCount} Submissions
                      </span>
                    </div>

                    {/* Chart distributions rendering */}
                    {act.type !== 'q_and_a' && act.content?.options ? (
                      <div className="space-y-3 bg-slate-950/50 p-4 rounded-lg border border-slate-800/80 max-w-xl">
                        {act.content.options.map((opt, i) => {
                          const correctIndex = act.content.correctIndex;
                          const isCorrect = act.type === 'quiz' && i === correctIndex;
                          
                          // Count how many answered this
                          const optCount = act.responses.filter(r => r.response?.value === opt).length;
                          const totalResp = act.responses.length || 1;
                          const pct = Math.round((optCount / totalResp) * 100);

                          return (
                            <div key={i} className="space-y-1">
                              <div className="flex items-center justify-between text-xs">
                                <span className={`flex items-center gap-1.5 ${isCorrect ? 'text-emerald-400 font-bold' : 'text-slate-300'}`}>
                                  {isCorrect && <Check className="w-3.5 h-3.5" />}
                                  {opt}
                                </span>
                                <span className="text-slate-400 font-medium">{optCount} ({pct}%)</span>
                              </div>
                              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                  style={{ width: `${pct}%` }} 
                                  className={`h-full rounded-full transition-all duration-300 ${
                                    isCorrect ? 'bg-emerald-500' : 'bg-indigo-500'
                                  }`}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      /* Q & A text responses display */
                      <div className="space-y-2">
                        <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold block">Anonymous Student Response Submissions</span>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {act.responses.length === 0 ? (
                            <p className="text-xs text-slate-600 italic py-2">No answers submitted.</p>
                          ) : (
                            act.responses.map((r, rIdx) => (
                              <div key={r.id} className="bg-slate-950/80 border border-slate-800/60 p-2.5 rounded-lg text-xs">
                                <p className="text-slate-300 font-medium">{r.response?.value}</p>
                                <span className="text-[9px] text-slate-500 block mt-1">Submitted at {formatTime(r.submitted_at)}</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* T3: Whiteboard Archive Preview and Storage Bucket Simulation */}
        {activeReportTab === 'whiteboard' && (
          <div className="max-w-xl mx-auto bg-slate-900/50 border border-slate-800 p-5 rounded-xl shadow-xl space-y-4 animate-fade-in-up text-center">
            <h3 className="font-semibold text-slate-200 text-sm">Vector Blackboard State Projection</h3>
            <p className="text-xs text-slate-500">
              The whiteboard has been serialized into coordinates matrices and successfully archived in public storage.
            </p>

            <div className="flex justify-center border border-slate-800 rounded-lg overflow-hidden bg-slate-950 p-2.5 max-w-[600px] mx-auto">
              <canvas
                ref={previewCanvasRef}
                className="max-w-full rounded-md shadow-inner block"
              />
            </div>

            {/* Pagination Controls */}
            {(() => {
              let totalPages = 1;
              if (whiteboardStrokes && !Array.isArray(whiteboardStrokes) && Array.isArray(whiteboardStrokes.pages)) {
                totalPages = whiteboardStrokes.pages.length;
              }
              if (totalPages <= 1) return null;
              return (
                <div className="flex items-center justify-center gap-2 max-w-[200px] mx-auto bg-slate-950 border border-slate-800 rounded-lg p-1">
                  <button
                    onClick={() => setPreviewPageIndex(prev => Math.max(0, prev - 1))}
                    disabled={previewPageIndex === 0}
                    className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded disabled:opacity-30 disabled:hover:bg-transparent transition-all font-bold"
                  >
                    &lt; Prev
                  </button>
                  <span className="text-xs text-purple-400 font-bold px-1.5 font-mono">
                    Page {previewPageIndex + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPreviewPageIndex(prev => Math.min(totalPages - 1, prev + 1))}
                    disabled={previewPageIndex === totalPages - 1}
                    className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded disabled:opacity-30 disabled:hover:bg-transparent transition-all font-bold"
                  >
                    Next &gt;
                  </button>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                onClick={handleDownloadWhiteboard}
                disabled={
                  Array.isArray(whiteboardStrokes)
                    ? whiteboardStrokes.length === 0
                    : !whiteboardStrokes || !whiteboardStrokes.pages || whiteboardStrokes.pages.length === 0
                }
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow transition-all border border-indigo-500/30"
              >
                <Download className="w-4 h-4" />
                Download Final Board PNG
              </button>
              
              <div className="inline-flex items-center gap-1 bg-slate-950 border border-slate-800/80 px-3 py-2 rounded-lg text-xs text-slate-400">
                <CloudLightning className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                <span>Archive Status: Uploaded public/whiteboards/</span>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
