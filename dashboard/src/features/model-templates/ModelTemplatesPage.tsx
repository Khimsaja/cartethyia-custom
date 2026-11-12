import { LayoutTemplate, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../data/api";
import type { ModelTemplateResponse } from "../../data/contracts";
import {
  useCreateModelTemplate,
  useDeleteModelTemplate,
  useModelTemplates,
  useSyncModelTemplate,
  useUpdateModelTemplate,
} from "../../hooks/model-templates";

/**
 * Model-template management: named model-list presets that API keys can
 * mirror. Saving a changed list applies it to every linked key
 * automatically; "Sync to keys" re-applies it on demand to repair drift.
 */
function TemplateForm({
  initial,
  busy,
  onSubmit,
}: {
  initial: { name: string; models: string[] } | null;
  busy: boolean;
  onSubmit: (input: { name: string; models: string[] }) => void;
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? "");
  const [modelsText, setModelsText] = useState((initial?.models ?? []).join("\n"));
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Input
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. tiprouter new"
        disabled={busy}
        autoFocus
      />
      <div className="form-group">
        <label className="form-label" htmlFor="template-models">
          Models (one per line; empty means every model)
        </label>
        <textarea
          className="form-textarea font-mono"
          id="template-models"
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          rows={8}
          placeholder={"deepseek-v-4.1-flash\nqwen3.8-flash-next"}
          disabled={busy}
        />
      </div>
      <div className="flex justify-end gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !name.trim()}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              models: modelsText
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Create template"}
        </Button>
      </div>
    </div>
  );
}

export default function ModelTemplatesPage(): ReactNode {
  const templatesQuery = useModelTemplates();
  const createTemplate = useCreateModelTemplate();
  const updateTemplate = useUpdateModelTemplate();
  const deleteTemplate = useDeleteModelTemplate();
  const syncTemplate = useSyncModelTemplate();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ModelTemplateResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelTemplateResponse | null>(null);

  const templates = templatesQuery.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Model Templates"
        subtitle="Named model-list presets. Link API keys to a template so their model access follows it."
        icon={<LayoutTemplate size={16} />}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
            icon={<Plus size={13} />}
          >
            Create Template
          </Button>
        }
      />
      <CardBody>
        {templatesQuery.isPending && !templatesQuery.data ? (
          <LoadingState label="Loading model templates…" />
        ) : templatesQuery.isError && !templatesQuery.data ? (
          <ErrorState
            message={getErrorMessage(templatesQuery.error, "Could not load model templates.")}
            onRetry={() => void templatesQuery.refetch()}
          />
        ) : templates.length === 0 ? (
          <EmptyState
            title="No model templates"
            message="Create a named preset (e.g. the buyer plan's model list), then link API keys to it from the key form."
            icon={<LayoutTemplate size={20} />}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {templates.map((template) => (
              <div
                key={template.id}
                className="flex items-start justify-between gap-6 px-6 py-4 rounded-chip border border-inner-border bg-surface-2 max-medium:flex-col"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-4 flex-wrap">
                    <strong className="text-body">{template.name}</strong>
                    <Badge tone="default">
                      {template.models.length === 0
                        ? "all models"
                        : `${template.models.length} model${template.models.length === 1 ? "" : "s"}`}
                    </Badge>
                  </div>
                  {template.models.length > 0 ? (
                    <p className="mt-2 text-badge text-text-tertiary font-mono break-words">
                      {template.models.slice(0, 6).join(", ")}
                      {template.models.length > 6
                        ? `, +${template.models.length - 6} more`
                        : ""}
                    </p>
                  ) : null}
                  <p className="mt-2 text-micro text-text-tertiary">
                    Created {new Date(template.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-3 shrink-0 flex-wrap">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<RefreshCw size={13} />}
                    disabled={syncTemplate.isPending}
                    onClick={() =>
                      syncTemplate.mutate(template.id, {
                        onSuccess: (res) =>
                          toast.success(
                            `Synced ${template.name}: ${res.updatedKeys.length} key${res.updatedKeys.length === 1 ? "" : "s"} updated` +
                              (res.skippedCount > 0 ? `, ${res.skippedCount} skipped` : ""),
                          ),
                        onError: (error) =>
                          toast.error(getErrorMessage(error, "Could not sync template.")),
                      })
                    }
                    title="Push this template's model list onto every linked key"
                  >
                    Sync to keys
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Pencil size={13} />}
                    onClick={() => setEditTarget(template)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    disabled={deleteTemplate.isPending}
                    onClick={() => setDeleteTarget(template)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Model Template"
        description="A named preset of model ids. Keys linked to it mirror this list."
      >
        <TemplateForm
          initial={null}
          busy={createTemplate.isPending}
          onSubmit={(input) =>
            createTemplate.mutate(input, {
              onSuccess: () => {
                setCreateOpen(false);
                toast.success("Model template created");
              },
              onError: (error) =>
                toast.error(getErrorMessage(error, "Could not create template.")),
            })
          }
        />
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit Model Template"
        description="Rename the template or change its model list. Saving a changed list applies it to every linked key automatically (excluded keys are left alone)."
      >
        <TemplateForm
          key={editTarget?.id ?? "new"}
          initial={editTarget ? { name: editTarget.name, models: [...editTarget.models] } : null}
          busy={updateTemplate.isPending}
          onSubmit={(input) => {
            if (!editTarget) return;
            updateTemplate.mutate(
              { templateId: editTarget.id, request: input },
              {
                onSuccess: (res) => {
                  setEditTarget(null);
                  if (res.sync) {
                    toast.success(
                      `Model template updated and applied to ${res.sync.updatedKeys.length} key${res.sync.updatedKeys.length === 1 ? "" : "s"}` +
                        (res.sync.skippedCount > 0
                          ? `, ${res.sync.skippedCount} skipped`
                          : ""),
                    );
                  } else {
                    toast.success("Model template updated");
                  }
                },
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not update template.")),
              },
            );
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteTemplate.mutateAsync(deleteTarget.id);
          toast.success(`Deleted ${deleteTarget.name}.`);
          setDeleteTarget(null);
        }}
        title="Delete model template?"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? Keys linked to it keep their current model list but lose the template link.`
            : "Delete this model template?"
        }
        confirmLabel="Delete"
        danger
      />
    </Card>
  );
}
