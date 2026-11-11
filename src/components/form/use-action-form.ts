"use client";
import { unstable_rethrow } from "next/navigation";
import { useForm, type DefaultValues, type FieldValues, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";
import type { ActionResult } from "@/types/action";
import { useI18n } from "@/components/i18n-provider";

type Options<In extends FieldValues, Out, T> = {
  schema: z.ZodType<Out, In>;
  defaultValues: DefaultValues<In>;
  action: (values: Out) => Promise<ActionResult<T> | undefined | void>;
  onSuccess?: (data: T) => void;
  /** Toast shown on success; omit for none (e.g. when the action redirects). */
  successMessage?: string;
};

/**
 * React Hook Form + Zod on the client, the same schema re-validated by the
 * server action. Server errors arrive already localized (src/lib/errors.ts).
 */
export function useActionForm<In extends FieldValues, Out, T = null>(opts: Options<In, Out, T>) {
  const { t } = useI18n();
  const form = useForm<In, unknown, Out>({
    resolver: zodResolver(opts.schema),
    defaultValues: opts.defaultValues,
  });

  const submit = form.handleSubmit(async (values) => {
    let res: ActionResult<T> | undefined | void;
    try {
      res = await opts.action(values);
    } catch (err) {
      unstable_rethrow(err); // redirect()/notFound() from the action
      // Network failure or an unexpected server error: never leave the form hanging.
      form.setError("root", { message: t.common.errorBody });
      return;
    }
    if (!res) return; // the action redirected
    if (res.ok) {
      if (opts.successMessage) toast.success(opts.successMessage);
      opts.onSuccess?.(res.data);
      return;
    }
    for (const [name, message] of Object.entries(res.fieldErrors ?? {})) {
      if (name !== "_") form.setError(name as Path<In>, { message });
    }
    form.setError("root", { message: res.error });
  }, (errors) => {
    // A field the screen does not show (or one scrolled out of view) can fail validation; never let Save do nothing silently.
    form.setError("root", { message: `${t.common.checkFields}: ${Object.keys(errors).filter((k) => k !== "root").join("، ")}` });
  });

  return { form, submit, pending: form.formState.isSubmitting };
}
