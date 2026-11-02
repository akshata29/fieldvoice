import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, MapPinIcon } from '@heroicons/react/24/outline';
import type { ExtractionResult, PhotoRef, StageTiming, WorkOrderDetail } from '@/api/types';
import type { EngineList } from '@/api/types';
import { isApiError, workOrdersApi } from '@/api/client';
import { buttonClasses } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback';
import { useToast } from '@/components/ui/Toast';
import { AssetsCard, JobInfoCard, KbPanel } from '@/components/domain/job/JobSidebar';
import { FormPanel, type SaveState } from '@/components/domain/job/FormPanel';
import { VoicePanel, type EngineSelection } from '@/components/domain/job/VoicePanel';
import { PriorityBadge } from '@/components/domain/StatusBadges';
import { invalidateLocalState, qk, useEngines } from '@/hooks/queries';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { spansFromFields } from '@/lib/evidence';
import { resolveSelection } from '@/lib/engineSelection';
import { prefillValues } from '@/lib/fieldMerge';
import { formReducer, initialFormState, selectValues } from '@/lib/formState';
import { buildDraft } from '@/lib/formLogic';

interface DraftMeta {
  transcript: string | null;
  stt: string | null;
  llm: string | null;
  strategy: string | null;
  timings: StageTiming[];
}

function JobWorkspace({ detail, engines }: { detail: WorkOrderDetail; engines: EngineList | undefined }) {
  const { work_order: wo, form, assets, draft, kb } = detail;
  const qc = useQueryClient();
  const toast = useToast();

  const [formState, dispatch] = useReducer(formReducer, undefined, () => initialFormState({ ...prefillValues(form, wo.prefill), ...(draft?.values ?? {}) }));
  const values = useMemo(() => selectValues(formState), [formState]);
  const [photos, setPhotos] = useState<PhotoRef[]>(draft?.photos ?? []);
  const [meta, setMeta] = useState<DraftMeta>({
    transcript: draft?.transcript ?? null,
    stt: draft?.stt_engine_id ?? null,
    llm: draft?.llm_engine_id ?? null,
    strategy: draft?.strategy_id ?? null,
    timings: draft?.timings ?? [],
  });
  const [lastResult, setLastResult] = useState<ExtractionResult | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [stored, setStored] = useLocalStorage<Partial<EngineSelection>>('fv.engines', {});
  const selection = useMemo(() => resolveSelection(stored, engines), [stored, engines]);

  const draftStatus = draft?.status ?? 'none';
  const locked = draftStatus === 'approved' || draftStatus === 'synced' || draftStatus === 'conflict';

  const voice = useVoiceSession({
    onStart: () => {
      dispatch({ type: 'session_start' });
      setLastResult(null);
    },
    onFields: (fields, stage) => dispatch(stage === 'result' ? { type: 'session_commit', fields } : { type: 'session_fields', fields }),
    onResult: (r) => {
      setLastResult(r);
      setMeta({ transcript: r.transcript_normalized || r.transcript_raw, stt: r.stt_engine_id, llm: r.llm_engine_id, strategy: r.strategy_id, timings: r.timings });
    },
  });

  // ---- autosave (debounced PUT /workorders/{id}/draft) -----------------------------------------------------------
  const snapshot = useMemo(() => ({ values, photos, meta }), [values, photos, meta]);
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const lastSaved = useRef(snapshot);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle', at: draft?.updated_at || null });

  const toDraft = useCallback(
    (snap: typeof snapshot) =>
      buildDraft({
        workOrder: wo,
        form,
        values: snap.values,
        transcript: snap.meta.transcript,
        sttEngineId: snap.meta.stt,
        llmEngineId: snap.meta.llm,
        strategyId: snap.meta.strategy,
        timings: snap.meta.timings,
        photos: snap.photos,
      }),
    [wo, form],
  );

  const save = useCallback(
    async (throwOnError = false) => {
      const snap = latest.current;
      if (snap === lastSaved.current) return;
      setSaveState((s) => ({ ...s, status: 'saving' }));
      try {
        const saved = await workOrdersApi.saveDraft(wo.id, toDraft(snap));
        lastSaved.current = snap;
        setSaveState({ status: 'saved', at: saved.updated_at });
        void qc.invalidateQueries({ queryKey: qk.workOrders });
      } catch (error) {
        setSaveState((s) => ({ ...s, status: 'error' }));
        if (throwOnError) throw error;
      }
    },
    [qc, toDraft, wo.id],
  );

  useEffect(() => {
    if (locked || snapshot === lastSaved.current) return;
    setSaveState((s) => (s.status === 'saving' ? s : { ...s, status: 'dirty' }));
    const timer = setTimeout(() => void save(), 900);
    return () => clearTimeout(timer);
  }, [snapshot, locked, save]);

  useEffect(
    () => () => {
      if (pinTimer.current) clearTimeout(pinTimer.current);
      const snap = latest.current;
      if (!lockedRef.current && snap !== lastSaved.current) void workOrdersApi.saveDraft(wo.id, toDraft(snap)).catch(() => undefined);
    },
    // flush once when leaving the page; toDraft and wo are stable for the lifetime of this workspace
    [],
  );

  const approve = useMutation({
    mutationFn: async () => {
      await save(true);
      return workOrdersApi.approve(wo.id);
    },
    onSuccess: (approved) => {
      qc.setQueryData<WorkOrderDetail>(qk.workOrder(wo.id), { ...detail, draft: approved, work_order: { ...wo, status: 'completed' } });
      invalidateLocalState(qc);
      toast.success('Approved and saved locally', 'It is queued for sync and will upload when you are online.');
    },
  });

  // ---- evidence highlighting --------------------------------------------------------------------------------------
  const spans = useMemo(
    () => (lastResult ? spansFromFields(lastResult.transcript_normalized, values, formState.sessionKeys) : []),
    [lastResult, values, formState.sessionKeys],
  );
  const evidenceKeys = useMemo(() => new Set(spans.map((s) => s.key)), [spans]);
  const activeKey = pinnedKey ?? hoverKey ?? focusKey;

  const onActivate = useCallback((key: string | null, via: 'hover' | 'focus') => (via === 'hover' ? setHoverKey(key) : setFocusKey(key)), []);
  const onShowEvidence = useCallback((key: string) => {
    setPinnedKey(key);
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = setTimeout(() => setPinnedKey(null), 4000);
    document.getElementById('transcript-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/" className="mb-1 inline-flex min-h-[36px] items-center gap-1 rounded-lg text-sm font-semibold text-brand-700 hover:underline field:min-h-[48px] field:text-base">
            <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" /> Today
          </Link>
          <h1 className="text-2xl font-bold leading-8 tracking-tight text-ink">{wo.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className="font-mono">{wo.id}</span>
            <span className="inline-flex items-center gap-1">
              <MapPinIcon className="h-4 w-4" aria-hidden="true" /> {wo.location}
            </span>
          </p>
        </div>
        <PriorityBadge priority={wo.priority} />
      </div>

      <div className="job-grid">
        <div className="job-area-info space-y-4">
          <JobInfoCard workOrder={wo} form={form} />
          <AssetsCard assets={assets} jobAssetIds={wo.asset_ids} />
          <KbPanel workOrderId={wo.id} initialHits={kb} />
        </div>

        <div className="job-area-voice" id="transcript-anchor">
          <VoicePanel
            workOrder={wo}
            form={form}
            voice={voice}
            engines={engines}
            selection={selection}
            onSelectionChange={(next) => setStored(next)}
            locked={locked}
            lastResult={lastResult}
            spans={spans}
            focusKey={activeKey}
            fields={form.fields}
            onExternalStart={() => {
              dispatch({ type: 'session_start' });
              setLastResult(null);
            }}
          />
        </div>

        <div className="job-area-form">
          <FormPanel
            form={form}
            workOrderId={wo.id}
            values={values}
            assets={assets}
            flashSeq={formState.flashSeq}
            activeKey={activeKey}
            evidenceKeys={evidenceKeys}
            draftStatus={draftStatus}
            saveState={saveState}
            photos={photos}
            approving={approve.isPending}
            onPhotoAdded={(ref) => setPhotos((p) => [...p, ref])}
            onEdit={(key, value) => dispatch({ type: 'edit', key, value })}
            onConfirm={(key) => dispatch({ type: 'confirm', key })}
            onActivate={onActivate}
            onShowEvidence={onShowEvidence}
            onApprove={() => approve.mutate()}
          />
        </div>
      </div>
    </div>
  );
}

export default function JobPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: qk.workOrder(id), queryFn: () => workOrdersApi.get(id), enabled: !!id, retry: false, refetchOnMount: 'always' });
  const engines = useEngines();

  if (query.isLoading) return <LoadingBlock label="Opening the job..." />;
  if (query.isError) {
    const err = query.error;
    if (isApiError(err) && err.code === 'unauthenticated') {
      return (
        <EmptyState
          title="Sign in to open this job"
          action={
            <Link to="/morning" className={buttonClasses({ variant: 'primary' })}>
              Go to Morning
            </Link>
          }
        >
          Work orders are downloaded after you sign in on the Morning screen.
        </EmptyState>
      );
    }
    if (isApiError(err) && err.code === 'not_found') {
      return (
        <EmptyState
          title="That job is not on this device"
          action={
            <Link to="/" className={buttonClasses({ variant: 'primary' })}>
              Back to Today
            </Link>
          }
        >
          It may not be in today's bundle. Run Morning prep while online to download the latest work orders.
        </EmptyState>
      );
    }
    return <ErrorState error={err} onRetry={() => void query.refetch()} />;
  }
  if (!query.data) return null;
  return <JobWorkspace key={id} detail={query.data} engines={engines.data} />;
}
