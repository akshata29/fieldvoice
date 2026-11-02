import { Link } from 'react-router-dom';
import {
  ArrowRightIcon,
  ArrowsRightLeftIcon,
  BookOpenIcon,
  CheckBadgeIcon,
  CircleStackIcon,
  CpuChipIcon,
  DevicePhoneMobileIcon,
  DocumentCheckIcon,
  MicrophoneIcon,
  PencilSquareIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { buttonClasses, type IconComponent } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Feedback';
import { Card, CardBody, CardHeader, KeyValue, PageHeader } from '@/components/ui/Card';
import { useSystemStatus } from '@/hooks/queries';
import { USE_MOCKS } from '@/lib/env';
import { cn } from '@/lib/cn';

interface Step {
  icon: IconComponent;
  title: string;
  text: string;
  tone: 'device' | 'model' | 'human' | 'sync';
}

const PIPELINE: Step[] = [
  { icon: MicrophoneIcon, title: 'Speak', text: 'The worker talks naturally; audio never leaves the device.', tone: 'human' },
  { icon: SparklesIcon, title: 'Streaming ASR', text: 'A local speech engine produces words while the worker is still talking.', tone: 'model' },
  { icon: Squares2X2Icon, title: 'Normalize numbers', text: '"pole one two three", "pole 1 2 3" and "pole 123" all become the same id.', tone: 'device' },
  { icon: CircleStackIcon, title: 'Closed-world resolver', text: "Ids and enums are matched deterministically against this job's assets and the form's lexicon. Nothing is invented.", tone: 'device' },
  { icon: CpuChipIcon, title: 'Small LLM, only for the rest', text: 'A small local model is asked about the fields the rules could not resolve - and only those.', tone: 'model' },
  { icon: ShieldCheckIcon, title: 'Validate', text: 'Ids must exist in the job, enums must be allowed options, numbers must be in range. Doubts become "needs review".', tone: 'device' },
  { icon: PencilSquareIcon, title: 'Worker review', text: 'The worker sees every value with its evidence and confidence, fixes what is wrong and approves.', tone: 'human' },
  { icon: DocumentCheckIcon, title: 'Save locally', text: 'The form and photos are stored on the device and queued in an outbox. This works with no connection.', tone: 'device' },
  { icon: ArrowsRightLeftIcon, title: 'Sync when online', text: 'The outbox uploads idempotently to the system of record; conflicts need a human decision.', tone: 'sync' },
];

const TONE: Record<Step['tone'], string> = {
  device: 'bg-brand-50 text-brand-800 ring-brand-200',
  model: 'bg-violet-50 text-violet-800 ring-violet-200',
  human: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  sync: 'bg-amber-50 text-amber-900 ring-amber-300',
};

const FINDINGS: Array<{ n: number; finding: string; consequence: string }> = [
  {
    n: 1,
    finding:
      'The Foundry catalog is wide: Whisper tiny to large-v3-turbo (0.13-1.3 GB), Parakeet-TDT-0.6B and Nemotron streaming ASR (~0.7 GB), Qwen2.5 (0.5-14B), Qwen3, Phi-3/3.5/4-mini/4, Ministral-3-3B (4.7 GB), SmolLM3-3B, Gemma-4-E2B (6 GB), Qwen3-Embedding.',
    consequence: 'Enumerate the catalog dynamically; never hard-code models.',
  },
  {
    n: 2,
    finding: '"GPT-3.5 mini" is not a catalog model; Phi-3.5-mini (3.8B, 2.6 GB) is.',
    consequence: 'Probably the model in use today - to be confirmed with the customer.',
  },
  {
    n: 3,
    finding: 'With execution providers registered, each model exposes NPU / GPU (OpenVINO) / GPU (WebGPU) / CPU variants. Auto-selection picked an OpenVINO NPU variant, which then failed to load.',
    consequence: 'Pin variants explicitly, self-test at startup, fall back to CPU. Test every variant on a real Latitude 7220.',
  },
  {
    n: 4,
    finding: 'Grammar-constrained output works (JSON schema as an object, or a lark grammar). On Qwen2.5-0.5B the output had perfect structure but mixed up and mangled pole and unit ids, and was not faster.',
    consequence: 'Constrain structure only. Resolve ids and enums deterministically. Score the silent-wrong rate, not JSON validity.',
  },
  {
    n: 5,
    finding: 'Number rendering differs per engine: Whisper-tiny "pole 1 2 3", Whisper-base "pole 123", Nemotron "pole one two three".',
    consequence: "Normalize numbers and match ids against the job's closed world, whatever the engine.",
  },
  {
    n: 6,
    finding: 'Streaming ASR (Nemotron live session): first text under 1 s, final text about 0.3 s after speech end (dev box). Parakeet rejected file transcription.',
    consequence: 'Use live sessions for perceived latency; speech-to-text latency can nearly vanish.',
  },
  {
    n: 7,
    finding: 'The OpenAI-style clients (chat client, live session) are deprecated and will be removed at the end of 2026.',
    consequence: 'Build on ChatSession / AudioSession.',
  },
  {
    n: 8,
    finding: 'Azure embedded (on-device) speech: limited-access registration, Windows 11+, 16 kHz mono PCM WAV only, SDKs for C#/C++/Java/Python/Go, no iOS.',
    consequence: 'Windows-only comparator. Request access early.',
  },
  {
    n: 9,
    finding:
      'Foundry Local targets Windows, Linux and macOS - no iOS. ONNX Runtime GenAI has iOS packaging history and a Phi-3 sample, but its README lists iOS as roadmap and an open issue reports memory growth when prefilling on iOS (#1540).',
    consequence: 'iPad / iOS is a time-boxed spike (see ios-spike/), not a supported path.',
  },
  {
    n: 10,
    finding: "Foundry Local's Windows (Windows ML) SDK requires Windows 11 24H2 (build 26100) or later.",
    consequence: 'Confirm the fleet OS build.',
  },
];

export default function AboutPage() {
  const { data: status } = useSystemStatus();
  return (
    <>
      <PageHeader
        eyebrow="Proof of concept"
        title="About Field Voice"
        subtitle="An offline-first voice-to-form app for utility field technicians, built on Microsoft Foundry Local: in-process, no containers, no cloud at inference time."
        actions={
          <Link to="/lab" className={buttonClasses({ variant: 'primary' })}>
            Try the Lab <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />
          </Link>
        }
      />

      <div className="space-y-5">
        <Card>
          <CardHeader title="How it works" subtitle="A hybrid pipeline: let the models do what they are good at and keep everything that must be right deterministic." icon={<BookOpenIcon className="h-6 w-6" aria-hidden="true" />} />
          <CardBody className="space-y-4">
            <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Pipeline steps">
              {PIPELINE.map((s, i) => (
                <li key={s.title} className="relative flex gap-3 rounded-xl border border-line bg-surface p-4 field:border-2">
                  <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset', TONE[s.tone])}>
                    <s.icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">
                      <span className="mr-1.5 text-sm font-medium text-muted">{i + 1}.</span>
                      {s.title}
                    </p>
                    <p className="mt-0.5 text-sm text-muted">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="flex flex-wrap gap-2 text-xs">
              <Badge tone="brand">deterministic, on device</Badge>
              <Badge tone="violet">local model</Badge>
              <Badge tone="green">the worker</Badge>
              <Badge tone="amber">needs a connection</Badge>
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
              <li>
                <strong>The day has three phases.</strong> Morning (connected): sign in, download work orders, forms, procedures and assets, and make sure the models are present and pass a self-test. During the day (offline): capture, review and save locally. Back online: the outbox syncs.
              </li>
              <li>
                <strong>Everything degrades gracefully.</strong> With no model installed, the rules-only strategy still extracts what it can and leaves the rest for the worker.
              </li>
              <li>
                <strong>Silent-wrong is the number we score,</strong> not whether the JSON parses: a confident wrong id is worse than an empty field.
              </li>
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Verified findings" subtitle="Research and smoke tests, 30 Oct 2026: Foundry Local SDK 2.2.1 (Python) on a Windows 11 development machine." icon={<CheckBadgeIcon className="h-6 w-6" aria-hidden="true" />} />
          <CardBody className="space-y-4">
            <Alert tone="warn" title="Timings from the development machine are not representative">
              The field device is a Dell Latitude 7220 Rugged Extreme (8th-gen U-series Intel CPU, 8/16 GB LPDDR3, UHD 620 graphics, no NPU, per Dell spec sheets). Findings are used for behaviour, not for sizing.
            </Alert>
            <ul className="grid gap-3 lg:grid-cols-2">
              {FINDINGS.map((f) => (
                <li key={f.n} className="flex gap-3 rounded-xl border border-line bg-surface p-4 field:border-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">{f.n}</span>
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-sm leading-6 text-ink">{f.finding}</p>
                    <p className="text-sm leading-6 text-brand-800">
                      <span className="font-semibold">So: </span>
                      {f.consequence}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="iPad and iOS: where we honestly stand" icon={<DevicePhoneMobileIcon className="h-6 w-6" aria-hidden="true" />} />
          <CardBody className="space-y-3 text-sm leading-6 text-ink">
            <p>
              This interface is built for tablet-sized touch screens and has a high-contrast Field mode for sunlight, but <strong>the models do not run on an iPad today</strong>.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Foundry Local targets Windows, Linux and macOS. There is no iOS build.</li>
              <li>ONNX Runtime GenAI has some iOS history, but lists iOS as roadmap and has an open memory-growth report. We treat it as a time-boxed spike, not a plan.</li>
              <li>Azure embedded speech has no iOS SDK either.</li>
              <li>An iPad can at most act as a client of a backend running on another machine, and browsers only expose the microphone on https or localhost.</li>
            </ul>
            <p className="text-muted">Nothing on this page claims on-device iPad inference works; the spike will say so if it ever does.</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="This build" icon={<CpuChipIcon className="h-6 w-6" aria-hidden="true" />} />
          <CardBody className="space-y-3">
            <KeyValue
              items={[
                ['Data source', USE_MOCKS ? <Badge key="m" tone="amber">Mock mode: simulated demo data</Badge> : <Badge key="r" tone="green">Connected to the backend</Badge>],
                ['Backend version', status?.version ?? '-'],
                ['Foundry Local SDK', status?.foundry.sdk_version ?? '-'],
                ['Device profile', status?.hardware.device_profile ?? '-'],
              ]}
            />
            {USE_MOCKS ? (
              <Alert tone="info">In mock mode every transcript, timing, model size and metric is fabricated by the in-browser mock backend so the interface can be demonstrated without models. None of it is a measurement.</Alert>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
