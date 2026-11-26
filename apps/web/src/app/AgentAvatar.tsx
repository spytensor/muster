import {
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  CalculatorIcon,
  CalendarDaysIcon,
  CodeIcon,
  HeadsetIcon,
  LanguagesIcon,
  type LucideIcon,
  MailIcon,
  MegaphoneIcon,
  PenLineIcon,
  PlugIcon,
  PresentationIcon,
  ScaleIcon,
  ScrollTextIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The face of an agent: a coloured tile with the sign of what it does, the way apps
 * are known on a phone. The sign is read from the agent's name and description (a
 * researcher searches, a writer writes); one that says nothing of the kind is a
 * robot, in a colour that is always the same for the same name.
 */
type Face = { icon: LucideIcon; from: string; to: string };
// The trade before the manner: a "legal assistant" is legal, a "data protection officer"
// is risk. Words are matched whole where a part of one would be another word ("hr" in
// "three", "present" in "representative").
const FACES: [RegExp, Face][] = [
  [
    /legal|contract|compliance|polic(y|ies)|法务|合同|合规|制度/i,
    { icon: ScaleIcon, from: "#8b5cf6", to: "#6d28d9" },
  ],
  [
    /risk|audit|security|protection|风控|审计|安全/i,
    { icon: ShieldCheckIcon, from: "#14b8a6", to: "#0f766e" },
  ],
  [
    /budget|financ|accounting|accountant|invoice|expense|预算|财务|报销|发票|会计/i,
    { icon: CalculatorIcon, from: "#10b981", to: "#047857" },
  ],
  [
    /\bhr\b|people|recruit|onboard|人事|招聘|入职|员工/i,
    { icon: UsersIcon, from: "#ec4899", to: "#be185d" },
  ],
  [
    /\bcod(e|ing)\b|develop|engineer|\bdev\b|代码|开发|工程师/i,
    { icon: CodeIcon, from: "#64748b", to: "#334155" },
  ],
  [/translat|locali[sz]|翻译|本地化/i, { icon: LanguagesIcon, from: "#0891b2", to: "#155e75" }],
  [
    /support|help ?desk|customer service|客服|服务台/i,
    { icon: HeadsetIcon, from: "#6366f1", to: "#4338ca" },
  ],
  [
    /calendar|schedul|meeting|日程|会议|排期/i,
    { icon: CalendarDaysIcon, from: "#ef4444", to: "#be123c" },
  ],
  [/research|\bsearch|调研|研究|搜索/i, { icon: SearchIcon, from: "#0ea5e9", to: "#2563eb" }],
  [
    /\bwrit(er|ing|e)\b|\bdraft|editor|copywrit|写作|撰写|文案|起草/i,
    { icon: PenLineIcon, from: "#e08a00", to: "#c2570a" },
  ],
  [
    /\bdeck|\bslides?\b|presentation|\bpitch|演示|幻灯|汇报/i,
    { icon: PresentationIcon, from: "#ea580c", to: "#dc2626" },
  ],
  [
    /\bdata\b|analy|\breport|metric|\bsales\b|数据|分析|报表|销售/i,
    { icon: BarChart3Icon, from: "#06b6d4", to: "#0e7490" },
  ],
  [/\bmail|inbox|邮件|邮箱/i, { icon: MailIcon, from: "#3b82f6", to: "#1d4ed8" }],
  [
    /messenger|\bsend|notif|webhook|发送|通知|消息/i,
    { icon: SendIcon, from: "#22c55e", to: "#0d9488" },
  ],
  [
    /\bmarketing|social|announce|campaign|市场|营销|公告/i,
    { icon: MegaphoneIcon, from: "#f43f5e", to: "#c2410c" },
  ],
  [/assistant|助手|助理|\bgeneral\b/i, { icon: SparklesIcon, from: "#7c5cff", to: "#4f8bff" }],
];
const PLAIN: [string, string][] = [
  ["#7c5cff", "#4f8bff"],
  ["#0ea5e9", "#2563eb"],
  ["#10b981", "#047857"],
  ["#e08a00", "#c2570a"],
  ["#f43f5e", "#be123c"],
  ["#14b8a6", "#0f766e"],
];
/** The other things a marketplace holds, each in its own colour. */
const THINGS: Record<"skill" | "knowledge" | "connector", Face> = {
  skill: { icon: ScrollTextIcon, from: "#a855f7", to: "#7e22ce" },
  knowledge: { icon: BookOpenIcon, from: "#d97706", to: "#b45309" },
  connector: { icon: PlugIcon, from: "#0ea5e9", to: "#0369a1" },
};

const SIZES = {
  xs: ["size-5 rounded-md", "size-3"],
  sm: ["size-7 rounded-lg", "size-4"],
  md: ["size-9 rounded-xl", "size-5"],
  lg: ["size-12 rounded-2xl", "size-6"],
} as const;

export function AgentAvatar({
  name,
  description = "",
  kind = "agent",
  size = "md",
  className,
}: {
  name: string;
  description?: string;
  /** What is being shown. An agent's face is read from its words; the others have one each. */
  kind?: "agent" | "skill" | "knowledge" | "connector";
  size?: keyof typeof SIZES;
  className?: string;
}) {
  let face: Face;
  if (kind !== "agent") face = THINGS[kind];
  else {
    // The name says more than the description: "Budget desk" is a budget agent whatever it reads.
    const found =
      FACES.find(([words]) => words.test(name)) ?? FACES.find(([words]) => words.test(description));
    const plain = PLAIN[
      [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PLAIN.length
    ] as [string, string];
    face = found?.[1] ?? { icon: BotIcon, from: plain[0], to: plain[1] };
  }
  const Icon = face.icon;
  const [box, glyph] = SIZES[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.25)]",
        box,
        className,
      )}
      style={{ backgroundImage: `linear-gradient(140deg, ${face.from}, ${face.to})` }}
    >
      <Icon className={glyph} strokeWidth={2.2} />
    </span>
  );
}
