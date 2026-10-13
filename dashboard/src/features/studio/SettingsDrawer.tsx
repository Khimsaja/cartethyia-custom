import { useEffect, useState, type ReactNode } from "react";
import { ModelPickerModal, type FlatModelEntry } from "../../components/ModelPicker";
import { Button } from "../../components/ui/button";
import { Drawer } from "../../components/ui/drawer";
import { Input, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import type { LabDraft } from "./session";

const PERSONAS = [
  { value: "cartethyia", label: "Cartethyia" },
  { value: "unset", label: "None" },
] as const;

const TOOL_PERMISSIONS = [
  { value: "ask", label: "Ask before running" },
  { value: "yolo", label: "YOLO (run automatically)" },
] as const;

/**
 * Chat settings stay inside the Model Lab card on desktop and use a drawer on mobile.
 *
 * The chat model remains selected on the composer; this panel configures its
 * role and independent native media workers.
 */
export function SettingsDrawer({
  open,
  onClose,
  draft,
  onChange,
  chatModel,
  catalog,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly draft: LabDraft;
  readonly onChange: (patch: Partial<LabDraft>) => void;
  readonly chatModel: string;
  readonly catalog: readonly FlatModelEntry[];
}): ReactNode {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const controls = (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-5">
        <h3 className="m-0 text-caption font-bold tracking-label uppercase text-text-tertiary">Request</h3>
        <div className="flex flex-col gap-2">
          <span className="text-caption font-medium text-text-secondary">Chat model (planner)</span>
          <p className="m-0 text-text-primary font-mono text-caption break-all">
            {chatModel.length > 0 ? chatModel : "Choose a chat model in the composer"}
          </p>
          <p className="m-0 text-text-tertiary text-caption leading-normal">
            The chat model plans and responds. Image and video workers are selected independently below.
          </p>
        </div>
        <WorkerModelPicker
          label="Image generation model"
          description="Generates images requested in chat; it does not replace the planner."
          serviceKind="imageGeneration"
          value={draft.imageWorkerModel}
          catalog={catalog}
          onChange={(imageWorkerModel) => onChange({ imageWorkerModel })}
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Image size"
            value={draft.imageSize}
            placeholder="1024x1024"
            maxLength={32}
            onChange={(event) => onChange({ imageSize: event.target.value })}
          />
          <Input
            label="Image count"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            step={1}
            value={draft.imageCount}
            onChange={(event) => onChange({ imageCount: event.target.value })}
          />
        </div>
        <WorkerModelPicker
          label="Video generation model"
          description="Generates video clips requested in chat; leave unset when no video worker is configured."
          serviceKind="videoGeneration"
          value={draft.videoWorkerModel}
          catalog={catalog}
          onChange={(videoWorkerModel) => onChange({ videoWorkerModel })}
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Video size"
            value={draft.videoSize}
            placeholder="Provider default"
            maxLength={32}
            onChange={(event) => onChange({ videoSize: event.target.value })}
          />
          <Input
            label="Video count"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            step={1}
            value={draft.videoCount}
            onChange={(event) => onChange({ videoCount: event.target.value })}
          />
        </div>
        <p className="m-0 text-text-tertiary text-caption leading-normal">
          Agent tools are always orchestrated through Chat Completions.
        </p>
        <Select
          label="Persona"
          aria-label="Persona"
          value={draft.persona}
          options={PERSONAS}
          onValueChange={(persona) => onChange({ persona: persona as LabDraft["persona"] })}
        />
        <Select
          label="Tool permission"
          aria-label="Tool permission"
          value={draft.toolPermission}
          options={TOOL_PERMISSIONS}
          onValueChange={(toolPermission) => onChange({ toolPermission: toolPermission as LabDraft["toolPermission"] })}
        />
        <p className="m-0 text-text-tertiary text-caption leading-normal">
          Ask pauses before web search or media generation. YOLO runs these tools without confirmation; user questions still wait for your answer.
        </p>
      </section>

      <section className="flex flex-col gap-5">
        <h3 className="m-0 text-caption font-bold tracking-label uppercase text-text-primary">Advanced</h3>
        <div className="flex flex-col gap-6">
          <p className="m-0 text-text-tertiary text-caption leading-normal">Empty fields leave the model default alone.</p>
          <div className="grid grid-cols-2 gap-5 max-medium:grid-cols-1">
            <Input
              label="Temperature"
              inputMode="decimal"
              value={draft.temperature}
              placeholder="0.7"
              onChange={(event) => onChange({ temperature: event.target.value })}
            />
            <Input
              label="Top P"
              inputMode="decimal"
              value={draft.topP}
              placeholder="1"
              onChange={(event) => onChange({ topP: event.target.value })}
            />
          </div>
          <Textarea
            label="System prompt"
            rows={6}
            value={draft.systemPrompt}
            placeholder="Optional instructions sent ahead of the conversation."
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
        </div>
      </section>
    </div>
  );

  return (
    <>
      <aside className="scroll-region flex-none w-128 min-h-0 overflow-y-auto border-l border-inner-border px-7 py-8 max-medium:hidden">
        <h2 className="m-0 mb-7 text-lead font-semibold text-text-primary">Chat settings</h2>
        {controls}
      </aside>
      <Drawer open={open && isMobile} onClose={onClose} title="Chat settings">{controls}</Drawer>
    </>
  );
}

function WorkerModelPicker({
  label,
  description,
  serviceKind,
  value,
  catalog,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly serviceKind: "imageGeneration" | "videoGeneration";
  readonly value: string;
  readonly catalog: readonly FlatModelEntry[];
  readonly onChange: (model: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const hasModels = catalog.some((entry) =>
    entry.kind === "model" && entry.entry.enabled && entry.entry.serviceKind === serviceKind,
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        disabled={!hasModels}
        title={value.length > 0 ? value : `Choose ${label.toLowerCase()}`}
        onClick={() => setOpen(true)}
        className="w-full min-w-0 justify-between border border-inner-border bg-surface-2 text-left"
      >
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {value.length > 0 ? value : hasModels ? "Select a model" : "No enabled worker available"}
        </span>
      </Button>
      {value.length > 0 ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="w-fit border-0 bg-transparent px-0 text-caption text-text-tertiary underline cursor-pointer hover:text-text-primary"
        >
          Clear selection
        </button>
      ) : null}
      <p className="m-0 text-text-tertiary text-caption leading-normal">{description}</p>
      <ModelPickerModal
        open={open}
        onClose={() => setOpen(false)}
        selected={value.length > 0 ? [value] : []}
        onToggle={() => {}}
        onSelectOne={onChange}
        multi={false}
        title={`Select ${label.toLowerCase()}`}
        size="md"
        filter={(entry) =>
          entry.kind === "model" && entry.entry.enabled && entry.entry.serviceKind === serviceKind
        }
      />
    </div>
  );
}
