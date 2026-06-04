-- ActiveClass Database Schema

-- 1. Profiles Table
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
    student_id TEXT UNIQUE
);

-- Enable RLS on Profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read access" ON public.profiles;
CREATE POLICY "Allow public read access" ON public.profiles
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow users to update own profile" ON public.profiles;
CREATE POLICY "Allow users to update own profile" ON public.profiles
    FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Allow users to insert own profile" ON public.profiles;
CREATE POLICY "Allow users to insert own profile" ON public.profiles
    FOR INSERT WITH CHECK (auth.uid() = id);


-- 2. Sessions Table
CREATE TABLE IF NOT EXISTS public.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    room_code TEXT UNIQUE NOT NULL,
    otp TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'ended')),
    total_activities INTEGER NOT NULL DEFAULT 0,
    is_locked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on Sessions
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read access" ON public.sessions;
CREATE POLICY "Allow authenticated read access" ON public.sessions
    FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow teachers to insert sessions" ON public.sessions;
CREATE POLICY "Allow teachers to insert sessions" ON public.sessions
    FOR INSERT WITH CHECK (auth.uid() = teacher_id);

DROP POLICY IF EXISTS "Allow teachers to update sessions" ON public.sessions;
CREATE POLICY "Allow teachers to update sessions" ON public.sessions
    FOR UPDATE USING (auth.uid() = teacher_id);


-- 3. Session Participants Table
CREATE TABLE IF NOT EXISTS public.session_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    activities_completed INTEGER NOT NULL DEFAULT 0,
    participation_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    is_present BOOLEAN NOT NULL DEFAULT false,
    manual_override BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(session_id, student_id)
);

-- Enable RLS on Session Participants
ALTER TABLE public.session_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read" ON public.session_participants;
CREATE POLICY "Allow authenticated read" ON public.session_participants
    FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow student to join" ON public.session_participants;
CREATE POLICY "Allow student to join" ON public.session_participants
    FOR INSERT WITH CHECK (auth.uid() = student_id);

DROP POLICY IF EXISTS "Allow update for teachers and self" ON public.session_participants;
CREATE POLICY "Allow update for teachers and self" ON public.session_participants
    FOR UPDATE USING (
        auth.uid() = student_id OR 
        EXISTS (
            SELECT 1 FROM public.sessions 
            WHERE id = session_id AND teacher_id = auth.uid()
        )
    );


-- 4. Activities Table
CREATE TABLE IF NOT EXISTS public.activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('poll', 'quiz', 'q_and_a')),
    content JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on Activities
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read" ON public.activities;
CREATE POLICY "Allow authenticated read" ON public.activities
    FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow teachers to manage activities" ON public.activities;
CREATE POLICY "Allow teachers to manage activities" ON public.activities
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.sessions 
            WHERE id = session_id AND teacher_id = auth.uid()
        )
    );


-- 5. Activity Responses Table
CREATE TABLE IF NOT EXISTS public.activity_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id UUID NOT NULL REFERENCES public.activities(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    response JSONB NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(activity_id, student_id)
);

-- Enable RLS on Activity Responses
ALTER TABLE public.activity_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read responses" ON public.activity_responses;
CREATE POLICY "Allow read responses" ON public.activity_responses
    FOR SELECT USING (
        auth.uid() = student_id OR 
        EXISTS (
            SELECT 1 FROM public.activities a 
            JOIN public.sessions s ON a.session_id = s.id 
            WHERE a.id = activity_id AND s.teacher_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Allow student to insert response" ON public.activity_responses;
CREATE POLICY "Allow student to insert response" ON public.activity_responses
    FOR INSERT WITH CHECK (auth.uid() = student_id);


-- 6. Whiteboard Data Table
CREATE TABLE IF NOT EXISTS public.whiteboard_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID UNIQUE NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    canvas_state JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on Whiteboard Data
ALTER TABLE public.whiteboard_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read" ON public.whiteboard_data;
CREATE POLICY "Allow authenticated read" ON public.whiteboard_data
    FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow teachers to manage whiteboard" ON public.whiteboard_data;
CREATE POLICY "Allow teachers to manage whiteboard" ON public.whiteboard_data
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.sessions 
            WHERE id = session_id AND teacher_id = auth.uid()
        )
    );


-- TRIGGERS & FUNCTIONS

-- Trigger A: Increment total_activities on Sessions when an activity is created
CREATE OR REPLACE FUNCTION public.increment_total_activities()
RETURNS TRIGGER AS $$
DECLARE
  v_total_activities INT;
BEGIN
  -- 1. Increment total_activities on the session
  UPDATE public.sessions
  SET total_activities = total_activities + 1
  WHERE id = NEW.session_id
  RETURNING total_activities INTO v_total_activities;

  -- 2. Recalculate percentages and presence for ALL participants in this session
  UPDATE public.session_participants
  SET 
    participation_percentage = CASE 
      WHEN v_total_activities = 0 THEN 0.00
      ELSE ROUND((activities_completed::numeric / v_total_activities::numeric) * 100, 2)
    END,
    is_present = CASE
      WHEN manual_override = TRUE THEN is_present
      ELSE (CASE 
        WHEN v_total_activities = 0 THEN false
        ELSE (activities_completed::numeric / v_total_activities::numeric * 100) >= 50.00
      END)
    END
  WHERE session_id = NEW.session_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_increment_total_activities ON public.activities;
CREATE TRIGGER trg_increment_total_activities
AFTER INSERT ON public.activities
FOR EACH ROW
EXECUTE FUNCTION public.increment_total_activities();


-- Trigger B: Update Student engagement & attendance on Activity Responses
CREATE OR REPLACE FUNCTION public.handle_activity_response_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_session_id UUID;
  v_total_activities INT;
  v_activities_completed INT;
  v_participation_percentage NUMERIC(5,2);
  v_is_present BOOLEAN;
  v_manual_override BOOLEAN;
BEGIN
  -- Get the session_id from the activity
  SELECT session_id INTO v_session_id
  FROM public.activities
  WHERE id = NEW.activity_id;

  -- Count how many unique activities in this session the student has answered (excluding anonymous responses)
  SELECT COUNT(DISTINCT r.activity_id) INTO v_activities_completed
  FROM public.activity_responses r
  JOIN public.activities a ON r.activity_id = a.id
  WHERE a.session_id = v_session_id 
    AND r.student_id = NEW.student_id
    AND COALESCE((r.response->>'is_anonymous')::boolean, false) IS NOT TRUE;

  -- Get total activities launched in this session
  SELECT total_activities INTO v_total_activities
  FROM public.sessions
  WHERE id = v_session_id;

  -- Calculate percentage
  IF v_total_activities = 0 THEN
    v_participation_percentage := 0.00;
  ELSE
    v_participation_percentage := ROUND((v_activities_completed::numeric / v_total_activities::numeric) * 100, 2);
  END IF;

  -- Get the current manual_override and presence status
  SELECT manual_override INTO v_manual_override
  FROM public.session_participants
  WHERE session_id = v_session_id AND student_id = NEW.student_id;

  -- Determine is_present status
  IF v_manual_override = TRUE THEN
    -- If manual override is true, do not touch is_present (keep the teacher's choice)
    UPDATE public.session_participants
    SET activities_completed = v_activities_completed,
        participation_percentage = v_participation_percentage
    WHERE session_id = v_session_id AND student_id = NEW.student_id;
  ELSE
    -- If no override, present if percentage >= 50
    v_is_present := (v_participation_percentage >= 50.00);
    UPDATE public.session_participants
    SET activities_completed = v_activities_completed,
        participation_percentage = v_participation_percentage,
        is_present = v_is_present
    WHERE session_id = v_session_id AND student_id = NEW.student_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_response_insert ON public.activity_responses;
CREATE TRIGGER trg_activity_response_insert
AFTER INSERT ON public.activity_responses
FOR EACH ROW
EXECUTE FUNCTION public.handle_activity_response_insert();


-- Trigger C: Reset is_present based on percentage if manual_override is updated from true to false
CREATE OR REPLACE FUNCTION public.handle_participant_update()
RETURNS TRIGGER AS $$
DECLARE
  v_total_activities INT;
BEGIN
  -- If manual_override changed from true to false, recalculate is_present
  IF OLD.manual_override = TRUE AND NEW.manual_override = FALSE THEN
    SELECT total_activities INTO v_total_activities
    FROM public.sessions
    WHERE id = NEW.session_id;
    
    IF v_total_activities = 0 THEN
      NEW.participation_percentage := 0.00;
      NEW.is_present := FALSE;
    ELSE
      NEW.participation_percentage := ROUND((NEW.activities_completed::numeric / v_total_activities::numeric) * 100, 2);
      NEW.is_present := (NEW.participation_percentage >= 50.00);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_participant_update ON public.session_participants;
CREATE TRIGGER trg_participant_update
BEFORE UPDATE ON public.session_participants
FOR EACH ROW
EXECUTE FUNCTION public.handle_participant_update();


-- Create storage buckets for final whiteboard captures
-- Note: Run the following in Supabase Storage or create manually:
-- Bucket name: 'whiteboards' (public: true)
