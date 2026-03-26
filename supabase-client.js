// Supabase Configuration
const SUPABASE_URL = "https://rohisluwkzoaxyzydvvb.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xZ5q4vggDdIAHwGo90N35A_HdBBJGJU";

// Initialize the global client securely
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true
    }
});
