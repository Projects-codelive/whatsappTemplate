'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check } from 'lucide-react';

const steps = [
  { label: 'Template', key: 'template' },
  { label: 'Audience', key: 'audience' },
  { label: 'Personalize', key: 'personalize' },
  { label: 'Send', key: 'send' },
] as const;

type AudienceState = {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
};

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function NewBroadcastPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceState>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerImageUrl, setHeaderImageUrl] = useState('');
  const [name, setName] = useState('');
  const [sendingMode, setSendingMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  // Clone: apply search params once templates are loaded.
  const cloneApplied = useRef(false);

  useEffect(() => {
    if (cloneApplied.current) return;

    const cloneName = searchParams.get('name');
    const cloneTemplate = searchParams.get('template');
    if (!cloneTemplate) return;

    cloneApplied.current = true;

    // Intentional one-shot hydration of the compose form from the
    // ?name/&audience/&variables clone params (guarded by cloneApplied).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cloneName) setName(cloneName);
    setAudience(
      safeParseJson<AudienceState>(searchParams.get('audience'), { type: 'all' }),
    );
    setVariables(
      safeParseJson(searchParams.get('variables'), {}),
    );
  }, [searchParams]);

  useEffect(() => {
    if (cloneApplied.current && template) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentStep(1);
    }
  }, [template]);

  async function handleSend() {
    if (!template) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerImageUrl: headerImageUrl || undefined,
        scheduledAt:
          sendingMode === 'scheduled' && scheduledAt
            ? scheduledAt
            : undefined,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error('Give the broadcast a name before saving a draft.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error('Not signed in.');
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
        customField: audience.customField,
        csvContacts: audience.csvContacts,
        excludeTagIds: audience.excludeTagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(`Failed to save draft: ${error.message}`);
      return;
    }
    toast.success('Draft saved');
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">New Broadcast</h1>
        <p className="mt-1 text-sm text-slate-400">
          Create and send a broadcast message to your contacts.
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-slate-700 bg-slate-800 text-slate-500'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-white' : isCompleted ? 'text-primary' : 'text-slate-500'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-slate-800'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
              initialTemplateName={searchParams.get('template') ?? undefined}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerImageUrl={headerImageUrl}
              onHeaderImageChange={setHeaderImageUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              headerImageUrl={headerImageUrl}
              sendingMode={sendingMode}
              onSendingModeChange={setSendingMode}
              scheduledAt={scheduledAt}
              onScheduledAtChange={setScheduledAt}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
