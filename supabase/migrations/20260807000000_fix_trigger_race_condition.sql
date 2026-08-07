-- Fix race condition in handle_new_user trigger
-- The original trigger used SELECT NOT EXISTS + INSERT which is not atomic.
-- Under concurrent signups, two users could both become owners.
-- Fix: Use a serializable check with advisory lock.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  first_user BOOLEAN;
BEGIN
  -- Insert profile
  INSERT INTO public.profiles (id, username, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'full_name'
  );

  -- Use advisory lock to prevent race condition on first-user check
  PERFORM pg_advisory_xact_lock(hashtext('brilink_first_user'));

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO first_user;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN first_user THEN 'owner'::public.app_role ELSE 'cashier'::public.app_role END);

  RETURN NEW;
END;
$$;
