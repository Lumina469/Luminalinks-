import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://dawdtzqgwhqchjuursjj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhd2R0enFnd2hxY2hqdXVyc2pqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1ODE2MzAsImV4cCI6MjA5MjE1NzYzMH0.IFukRWG6r6oLRT4HdLBHVCk2q-kjtcXRB47ZxbXG1Zs';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
