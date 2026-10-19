/* =====================================================================
   CONNECTION SETTINGS — Brigit's Supabase (same project as ASH and the trivia game)
   The publishable key is designed to be public: the database's access
   rules (supabase/schema.sql) decide what each signed-in person may see.
   Only people listed in the sp_users table can see any stock data.
   ===================================================================== */
window.SP_CONFIG = {
  supabaseUrl: "https://sxxfuxwgxeitvkbtywhp.supabase.co",
  supabaseAnonKey: "sb_publishable_2cHhIpWBoWqdavlzF9SukA_G_HG03GE",
  // email addresses allowed to register / sign in
  emailDomains: ["brigit.co.za", "elveygroup.com"]
};
