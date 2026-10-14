import type { NotificationStore } from "./notification-store.js";
import type { Reply } from "./types.js";
import { PublicError } from "./types.js";
import { digest } from "./security.js";
import {
  quietHoursLabel,
  quietHoursSchema,
  type QuietHours,
} from "./quiet-hours.js";
import type { ReminderQueue } from "./reminder-queue.js";

export type ReminderDraft = {
  type: "reminder";
  account: string;
  operationId: string;
  id: string;
  revision: number;
  doc: any;
  operation: string;
};
export type QuietDraft = { type: "quiet"; data: QuietHours };
type Wizard =
  | {
      type: "reminder_options";
      step: "repeat" | "minutes" | "quiet";
      reminder: ReminderDraft;
      review: string;
    }
  | { type: "quiet_options" };
export class NotificationDialogs {
  constructor(
    readonly db: NotificationStore,
    readonly queue: ReminderQueue,
    readonly timeZone: string,
    readonly review: (
      sender: string,
      data: ReminderDraft | QuietDraft,
      text: string,
    ) => Promise<Reply>,
  ) {}
  async beginReminder(sender: string, reminder: ReminderDraft, review: string) {
    return this.ask(sender, {
      type: "reminder_options",
      step: "repeat",
      reminder,
      review,
    });
  }
  private async ask(sender: string, w: Wizard): Promise<Reply> {
    const token = await this.db.draft(sender, w);
    const cancel = { id: `hub:notify:cancel:${token}`, title: "Cancelar" };
    if (w.type === "quiet_options")
      return {
        text: `Qual será seu período de silêncio? Envie início e fim, por exemplo: “22:00 às 07:00”. Fuso: ${(await this.queue.settings(sender))?.timeZone ?? this.timeZone}. Ele bloqueará avisos e repetições de todos os lembretes, exceto os que você configurar para ignorá-lo.`,
        buttons: [cancel],
      };
    const button = (v: string, title: string) => ({
      id: `hub:option:${v}:${token}`,
      title,
    });
    if (w.step === "repeat")
      return {
        text: `${w.reminder.doc.title}\nDeseja repetir este aviso até marcar como concluído?\nConfiguração atual: ${w.reminder.doc.requires_confirmation ? "sim" : "não"}.`,
        buttons: [button("yes", "Sim"), button("no", "Não"), cancel],
      };
    if (w.step === "minutes")
      return {
        text: `De quantos em quantos minutos devo repetir enquanto estiver pendente? Envie um número inteiro entre 1 e 10080. Atual: ${w.reminder.doc.repeat_minutes} minutos.`,
        buttons: [cancel],
      };
    return {
      text: `Este lembrete deve respeitar seu período de silêncio?\nSilêncio global: ${quietHoursLabel(await this.queue.settings(sender))}.\nConfiguração atual: ${w.reminder.doc.respect_quiet_hours ? "respeitar" : "ignorar"}. Ignorar permite avisos inclusive de madrugada.`,
      buttons: [
        button("respect", "Respeitar silêncio"),
        button("ignore", "Ignorar silêncio"),
        cancel,
      ],
    };
  }
  async prepareQuiet(sender: string, input: unknown): Promise<Reply> {
    if (input && typeof input === 'object' && !Array.isArray(input) && (input as any).timeZone === null)
      input = {...input,timeZone:(await this.queue.settings(sender))?.timeZone??this.timeZone};
    const data = quietHoursSchema.safeParse(input);
    if (!data.success)
      throw new PublicError(
        "Informe início e fim diferentes em HH:MM e um fuso válido. Exemplo: silêncio das 22:00 às 07:00.",
      );
    return this.review(
      sender,
      { type: "quiet", data: data.data },
      `Revisar período de silêncio\n${quietHoursLabel(data.data)}\nVale para todos os seus lembretes que respeitam o silêncio, inclusive o primeiro aviso. As exceções por lembrete serão preservadas. Ao terminar, somente a ocorrência vigente poderá ser enviada, sem acumular repetições.\nConfirme pelo botão para salvar.`,
    );
  }
  async command(
    sender: string,
    command: string,
    button?: string,
  ): Promise<Reply | null> {
    if (
      ["silencio", "periodo de silencio", "meu periodo de silencio"].includes(
        command,
      )
    )
      return {
        text: `Período de silêncio: ${quietHoursLabel(await this.queue.settings(sender))}.\nAs exceções são configuradas em cada lembrete.`,
        buttons: [
          { id: "hub:quiet:setup", title: "Configurar silêncio" },
          { id: "hub:quiet:off", title: "Desativar silêncio" },
        ],
      };
    if (
      button === "hub:quiet:setup" ||
      [
        "configurar silencio",
        "configurar periodo de silencio",
        "alterar silencio",
      ].includes(command)
    )
      return this.ask(sender, { type: "quiet_options" });
    if (
      button === "hub:quiet:off" ||
      ["desativar silencio", "desativar periodo de silencio"].includes(command)
    )
      return this.prepareQuiet(sender, {
        ...((await this.queue.settings(sender)) ?? {
          start: "00:00",
          end: "00:00",
          timeZone: this.timeZone,
        }),
        enabled: false,
      });
    const selection =
      /^hub:option:(yes|no|respect|ignore):([A-Za-z0-9_-]{43})$/.exec(
        button || "",
      );
    const pending = await this.db.pending<Wizard>(sender);
    if (selection && (!pending || pending.hash !== digest(selection[2])))
      return {
        text: "Esta escolha expirou ou foi substituída. Retome a configuração do lembrete.",
      };
    if (
      !pending ||
      !["reminder_options", "quiet_options"].includes(pending.data.type)
    )
      return null;
    if (command === "cancelar" && !button) {
      await this.db.cancelPending(sender, pending.hash);
      return { text: "Configuração cancelada. Nenhuma alteração foi salva." };
    }
    const w = pending.data;
    if (w.type === "quiet_options" && !button) {
      const range =
        /^(\d{1,2})(?::|h)?(\d{2})?\s*(?:as|ate|-)\s*(\d{1,2})(?::|h)?(\d{2})?$/.exec(
          command,
        );
      if (!range)
        return /\d/.test(command)
          ? { text: "Envie o período como “22:00 às 07:00”, ou “cancelar”." }
          : null;
      const data = {
        enabled: true,
        start: `${range[1].padStart(2, "0")}:${range[2] || "00"}`,
        end: `${range[3].padStart(2, "0")}:${range[4] || "00"}`,
        timeZone:
          (await this.queue.settings(sender))?.timeZone ?? this.timeZone,
      };
      if (!quietHoursSchema.safeParse(data).success)
        return {
          text: "Horários inválidos. Use HH:MM, com início e fim diferentes.",
        };
      if (!(await this.db.cancelPending(sender, pending.hash)))
        return {
          text: "A configuração mudou. Envie “configurar silêncio” novamente.",
        };
      return this.prepareQuiet(sender, data);
    }
    if (w.type !== "reminder_options") return null;
    if (w.step === "minutes" && !button) {
      if (
        !/^\d+$/.test(command) ||
        !Number.isSafeInteger(Number(command)) ||
        Number(command) < 1 ||
        Number(command) > 10080
      )
        return /\d/.test(command)
          ? {
              text: "Envie somente um número inteiro de 1 a 10080 minutos. Zero, números negativos e frações não são válidos.",
            }
          : null;
      if (!(await this.db.cancelPending(sender, pending.hash)))
        return { text: "Esta configuração foi substituída." };
      w.reminder.doc.repeat_minutes = Number(command);
      w.step = "quiet";
      return this.ask(sender, w);
    }
    if (!selection) return null;
    const value = selection[1];
    if (
      (w.step === "repeat" && !["yes", "no"].includes(value)) ||
      (w.step === "quiet" && !["respect", "ignore"].includes(value)) ||
      w.step === "minutes"
    )
      return { text: "Use os botões da pergunta atual." };
    if (!(await this.db.cancelPending(sender, pending.hash)))
      return { text: "Esta escolha já foi processada." };
    if (w.step === "repeat") {
      w.reminder.doc.requires_confirmation = value === "yes";
      w.step = value === "yes" ? "minutes" : "quiet";
      return this.ask(sender, w);
    }
    w.reminder.doc.respect_quiet_hours = value === "respect";
    const d = w.reminder.doc;
    return this.review(
      sender,
      w.reminder,
      `${w.review.replace(/\nConfirme pelo botão para salvar\.$/, "")}\nRequer confirmação: ${d.requires_confirmation ? "sim" : "não"}${d.requires_confirmation ? `\nRepetir até concluir: a cada ${d.repeat_minutes} minutos` : ""}\nPeríodo de silêncio: ${d.respect_quiet_hours ? "respeitar" : "ignorar para este lembrete"}.\nConfirme pelo botão para salvar.`,
    );
  }
}
