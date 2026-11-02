import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowRightIcon, CameraIcon, CheckBadgeIcon, ClipboardDocumentCheckIcon } from '@heroicons/react/24/solid';
import type { Asset, FormSchema, PhotoRef, Scalar } from '@/api/types';
import type { DraftStatus } from '@/api/types';
import { photoUrl, workOrdersApi } from '@/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Alert, Spinner } from '@/components/ui/Feedback';
import { FormRenderer } from '@/components/domain/form/FormRenderer';
import { useToast } from '@/components/ui/Toast';
import type { FieldValues } from '@/lib/fieldMerge';
import { fmtBytes, fmtTime, plural } from '@/lib/format';
import { summarizeForm } from '@/lib/formLogic';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
export interface SaveState {
  status: SaveStatus;
  at: string | null;
}

function SaveIndicator({ state }: { state: SaveState }) {
  switch (state.status) {
    case 'dirty':
      return <span className="text-xs font-medium text-amber-800">Unsaved changes...</span>;
    case 'saving':
      return (
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
          <Spinner className="h-3.5 w-3.5" /> Saving locally...
        </span>
      );
    case 'saved':
      return <span className="text-xs font-medium text-emerald-700">Saved on this device {state.at ? fmtTime(state.at) : ''}</span>;
    case 'error':
      return <span className="text-xs font-semibold text-red-700">Could not save - will retry on your next change</span>;
    default:
      return <span className="text-xs text-muted">Changes save automatically</span>;
  }
}

function PhotosCard({ workOrderId, photos, disabled, onAdded }: { workOrderId: string; photos: PhotoRef[]; disabled: boolean; onAdded: (ref: PhotoRef) => void }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PhotoRef | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => workOrdersApi.uploadPhoto(workOrderId, file),
    onSuccess: (ref) => {
      onAdded(ref);
      toast.success('Photo attached', `${ref.filename} (${fmtBytes(ref.size_bytes)}) is stored on this device.`);
    },
  });
  return (
    <Card>
      <CardHeader
        title="Photos"
        subtitle="Attach site photos; they sync with the completion."
        icon={<CameraIcon className="h-6 w-6" aria-hidden="true" />}
        actions={
          <>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-label="Take or choose a photo"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) upload.mutate(file);
              }}
            />
            <Button icon={CameraIcon} loading={upload.isPending} disabled={disabled} onClick={() => inputRef.current?.click()}>
              Add photo
            </Button>
          </>
        }
      />
      <CardBody>
        {photos.length === 0 ? (
          <p className="text-sm text-muted">No photos yet.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setPreview(p)}
                  className="group block w-full overflow-hidden rounded-lg border border-line bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 field:border-2 field:border-black"
                  aria-label={`Open photo ${p.filename}`}
                >
                  <img src={photoUrl(p.id)} alt={p.filename} loading="lazy" className="aspect-square w-full object-cover transition-transform group-hover:scale-105" />
                </button>
                <p className="mt-1 truncate text-xs text-muted" title={p.filename}>
                  {p.filename}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Dialog open={preview !== null} onClose={() => setPreview(null)} title={preview?.filename ?? 'Photo'} description={preview ? `${fmtBytes(preview.size_bytes)} - taken ${fmtTime(preview.taken_at)}` : undefined} size="lg">
          {preview ? <img src={photoUrl(preview.id)} alt={preview.filename} className="mx-auto max-h-[70vh] rounded-lg" /> : null}
        </Dialog>
      </CardBody>
    </Card>
  );
}

export interface FormPanelProps {
  form: FormSchema;
  workOrderId: string;
  values: FieldValues;
  assets: Asset[];
  flashSeq: Record<string, number>;
  activeKey: string | null;
  evidenceKeys: ReadonlySet<string>;
  draftStatus: DraftStatus;
  saveState: SaveState;
  photos: PhotoRef[];
  approving: boolean;
  onPhotoAdded: (ref: PhotoRef) => void;
  onEdit: (key: string, value: Scalar) => void;
  onConfirm: (key: string) => void;
  onActivate: (key: string | null, via: 'hover' | 'focus') => void;
  onShowEvidence: (key: string) => void;
  onApprove: () => void;
}

export function FormPanel(props: FormPanelProps) {
  const { form, values, draftStatus, saveState, approving, photos } = props;
  const locked = draftStatus === 'approved' || draftStatus === 'synced' || draftStatus === 'conflict';
  const summary = useMemo(() => summarizeForm(form, values), [form, values]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const blocked = summary.requiredMissing.length > 0 || summary.outOfRange.length > 0;
  const blockReason = summary.requiredMissing.length > 0
    ? `${plural(summary.requiredMissing.length, 'required field')} missing`
    : summary.outOfRange.length > 0
      ? `${plural(summary.outOfRange.length, 'value')} out of range`
      : '';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={form.title}
          subtitle={<SaveIndicator state={saveState} />}
          icon={<ClipboardDocumentCheckIcon className="h-6 w-6" aria-hidden="true" />}
          actions={
            <span className="flex flex-wrap items-center gap-1.5" aria-live="polite">
              {summary.requiredMissing.length > 0 ? (
                <Badge tone="red">{plural(summary.requiredMissing.length, 'required field')} missing</Badge>
              ) : (
                <Badge tone="green">Required fields complete</Badge>
              )}
              {summary.needsReview.length > 0 ? <Badge tone="amber">{summary.needsReview.length} to review</Badge> : null}
              <Badge tone="gray">
                {summary.filled}/{summary.total} filled
              </Badge>
            </span>
          }
        />
        <CardBody className="space-y-4">
          {draftStatus === 'approved' ? (
            <Alert
              tone="success"
              title="Queued for sync"
              live
              actions={
                <Link to="/sync" className={buttonClasses({ size: 'sm', variant: 'secondary' })}>
                  Open Sync <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
                </Link>
              }
            >
              Approved and saved on this device. It will be sent to dispatch the next time you sync while online.
            </Alert>
          ) : null}
          {draftStatus === 'synced' ? (
            <Alert tone="success" title="Synced">
              This completion has reached dispatch. The form is read-only.
            </Alert>
          ) : null}
          {draftStatus === 'conflict' ? (
            <Alert
              tone="error"
              title="Conflict with dispatch"
              actions={
                <Link to="/sync" className={buttonClasses({ size: 'sm', variant: 'secondary' })}>
                  Resolve on Sync
                </Link>
              }
            >
              Dispatch changed this job after you started. Choose to keep your version or take theirs on the Sync screen.
            </Alert>
          ) : null}

          <FormRenderer
            form={form}
            values={values}
            assets={props.assets}
            disabled={locked}
            flashSeq={props.flashSeq}
            activeKey={props.activeKey}
            evidenceKeys={props.evidenceKeys}
            onEdit={props.onEdit}
            onConfirm={props.onConfirm}
            onActivate={props.onActivate}
            onShowEvidence={props.onShowEvidence}
          />
        </CardBody>
      </Card>

      <PhotosCard workOrderId={props.workOrderId} photos={photos} disabled={locked} onAdded={props.onPhotoAdded} />

      {!locked ? (
        <div className="sticky bottom-[4.75rem] z-20 rounded-2xl border border-line bg-surface/95 p-3 shadow-pop backdrop-blur lg:static lg:bottom-auto lg:shadow-card field:border-2 field:border-black">
          <Button
            variant="success"
            size="lg"
            fullWidth
            icon={CheckBadgeIcon}
            loading={approving}
            disabled={blocked}
            onClick={() => (summary.needsReview.length > 0 ? setConfirmOpen(true) : props.onApprove())}
          >
            Approve &amp; save locally
          </Button>
          <p className="mt-2 text-center text-xs text-muted" aria-live="polite">
            {blocked ? `${blockReason}. Fill ${summary.requiredMissing.length > 0 ? 'the required fields' : 'the highlighted values'} to approve.` : 'Saved on this device and queued for sync. Works offline.'}
            {photos.length > 0 ? ` ${plural(photos.length, 'photo')} will upload with it.` : ''}
          </p>
        </div>
      ) : null}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Some values still need review"
        description="These were proposed by the system and have not been confirmed. Approve anyway, or go back and check them."
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>Go back and review</Button>
            <Button
              variant="success"
              onClick={() => {
                setConfirmOpen(false);
                props.onApprove();
              }}
            >
              Approve anyway
            </Button>
          </>
        }
      >
        <ul className="space-y-1.5 text-sm">
          {summary.needsReview.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 field:border-2 field:border-black">
              <span className="font-medium text-ink">{f.label}</span>
              <Badge tone="amber" size="sm">
                needs review
              </Badge>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
