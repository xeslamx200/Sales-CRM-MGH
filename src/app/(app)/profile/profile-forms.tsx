"use client";
import { useMemo } from "react";
import { FieldGroup } from "@/components/ui/field";
import { FormError, SelectField, SubmitButton, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { makeNewPasswordSchema, profileSchema } from "@/schemas/auth";
import { updatePassword, updateProfile } from "@/actions/auth";

export function ProfileForm({ defaults }: { defaults: { fullName: string; phone: string | null; locale: "ar" | "en" } }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: profileSchema,
    defaultValues: defaults,
    action: updateProfile,
    successMessage: t.common.saved,
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="fullName" label={t.common.fullName} autoComplete="name" />
        <TextField control={form.control} name="phone" type="tel" label={t.common.phone} autoComplete="tel" />
        <SelectField control={form.control} name="locale" label={t.profile.locale}
          options={[{ value: "ar", label: t.common.arabic }, { value: "en", label: t.common.english }]} />
        <div><SubmitButton pending={pending}>{t.common.save}</SubmitButton></div>
      </FieldGroup>
    </form>
  );
}

export function PasswordForm() {
  const { t } = useI18n();
  const schema = useMemo(() => makeNewPasswordSchema(t.auth.passwordMismatch), [t]);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { password: "", confirm: "" },
    action: updatePassword,
    successMessage: t.auth.passwordUpdated,
    onSuccess: () => form.reset(),
  });
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <FormError message={form.formState.errors.root?.message} />
        <TextField control={form.control} name="password" type="password" label={t.auth.newPassword}
          autoComplete="new-password" description={t.auth.passwordTooShort} />
        <TextField control={form.control} name="confirm" type="password" label={t.auth.confirmPassword} autoComplete="new-password" />
        <div><SubmitButton pending={pending}>{t.common.save}</SubmitButton></div>
      </FieldGroup>
    </form>
  );
}
