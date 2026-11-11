-- =============================================================================
-- 0880 — Controlled reassignment of a WhatsApp conversation to another company.
--
-- SECURITY INVOKER: RLS and app.guard_conversation decide (only someone who
-- manages BOTH companies may move it; the after-update trigger audits it and
-- links the contact to the new company). In addition:
--   * the owner is cleared if they are not an active member of the new
--     company (an owner must be able to work the conversation there);
--   * a non-empty reason is required and kept as an internal note.
-- =============================================================================
create or replace function public.move_conversation_company(
  p_conversation_id uuid, p_company_id uuid, p_reason text
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_conv record;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'conversation.move_reason_required' using errcode = '23514';
  end if;
  select id, company_id, owner_id into v_conv from public.conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'conversation.not_found' using errcode = 'P0002';
  end if;
  if v_conv.company_id = p_company_id then
    return;
  end if;
  -- Note first: after the move the caller may no longer see the conversation.
  insert into public.conversation_notes (conversation_id, author_id, body)
  values (p_conversation_id, auth.uid(), left('↔ ' || btrim(p_reason), 5000));
  update public.conversations
  set company_id = p_company_id,
      owner_id = case when owner_id is not null and app.is_company_member(p_company_id, owner_id) then owner_id end
  where id = p_conversation_id;
end $$;

revoke execute on function public.move_conversation_company(uuid, uuid, text) from public, anon;
grant execute on function public.move_conversation_company(uuid, uuid, text) to authenticated;
