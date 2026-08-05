
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shift_is_writable(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shift_is_readable(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shift_is_writable(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shift_is_readable(uuid) TO authenticated, service_role;
