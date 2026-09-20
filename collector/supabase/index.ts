import {handle} from './handler.mjs';
Deno.serve(request=>handle(request,{url:Deno.env.get('SUPABASE_URL'),key:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}));
