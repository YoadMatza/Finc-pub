import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { Card, Empty, ErrorBox, Spinner } from '../components/ui';
import { HOLDING_RULES_KEY, draftOf, isKnownTemplate, keepUntouched, templateHelp, orderedTemplates, paramLabel, parseParam, parseParams, ruleChanges, ruleSentence, suggestions, templateLabel } from '../holdingRules';
import { useI18n } from '../i18n';
import { errorText } from '../limits';
import type { HoldingRule, HoldingRuleInput, HoldingRuleParamSpec, HoldingRuleTemplate, HoldingRulesPayload } from '../types';


/** After any change: the list, and the panels and badges that show the rules' results. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: HOLDING_RULES_KEY });
    void qc.invalidateQueries({ queryKey: ['insights'] });
    void qc.invalidateQueries({ queryKey: ['holdings'] });
    // the hub evaluates at once; a second, cheap refetch picks up a result that landed just after the first
    setTimeout(() => void qc.invalidateQueries({ queryKey: ['holdings'] }), 2000);
  };
}

/**
 * Settings → My stock rules (stock decision aids A, step 1): the owner's own conditions over numbers finc already has.
 * List, add from a template, edit numbers / scope / on-off, delete; a few examples that are added switched off.
 * finc only reports when a rule applies; nothing here says what to do. `?symbol=` preselects the scope of a new rule
 * (the insights panel links here with the holding's symbol).
 */
export function StockRules() {
  const { t, locale } = useI18n();
  const [search] = useSearchParams();
  const q = useQuery({ queryKey: HOLDING_RULES_KEY, queryFn: () => api.get<HoldingRulesPayload>('/api/holding-rules') });
  const invalidate = useInvalidate();
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(errorText(e, 'rules', t, locale));
  const create = useMutation({ mutationFn: (body: HoldingRuleInput) => api.post<HoldingRule>('/api/holding-rules', body), onMutate: () => setErr(null), onError: fail, onSuccess: invalidate });
  const [adding, setAdding] = useState(() => !!search.get('symbol'));

  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const { rules, templates, symbols } = q.data;
  const preScope = search.get('symbol');
  const examples = suggestions(templates, rules);
  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <Link to="/settings" className="btn btn-sm self-start">
        <span aria-hidden className="rtl:rotate-180 inline-block">
          ←
        </span>
        {t('hr_back')}
      </Link>
      <Card title={t('hr_title')}>
        <p className="text-sm text-muted leading-relaxed">{t('hr_intro')}</p>
      </Card>
      {err && (
        <div className="card p-3 border-warn/50 text-warn text-sm" role="alert">
          {err}
        </div>
      )}
      <Card
        action={
          !adding && (
            <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
              {t('hr_add')}
            </button>
          )
        }
        title={t('hr_count', { n: rules.length, on: rules.filter((r) => r.enabled).length })}
      >
        {adding && (
          <div className="mb-3">
            <RuleForm
              templates={templates}
              symbols={symbols}
              initial={{ template: null, params: null, scopeSymbol: preScope && symbols.includes(preScope) ? preScope : null, enabled: true }}
              pending={create.isPending}
              onCancel={() => setAdding(false)}
              onSubmit={(v) =>
                create.mutate(
                  { template: v.template, params: v.params, scopeSymbol: v.scopeSymbol, enabled: v.enabled, notify: false },
                  { onSuccess: () => setAdding(false) },
                )
              }
            />
          </div>
        )}
        {rules.length === 0 ? (
          !adding && <Empty>{t('hr_none')}</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} templates={templates} symbols={symbols} onError={fail} clearError={() => setErr(null)} />
            ))}
          </ul>
        )}
      </Card>
      {examples.length > 0 && (
        <Card title={t('hr_examples')}>
          <p className="text-xs text-muted mb-2">{t('hr_examples_help')}</p>
          <ul className="flex flex-col divide-y divide-border">
            {examples.map((ex) => {
              const tpl = templates.find((x) => x.id === ex.template);
              return (
                <li key={ex.template} className="py-2 flex items-center gap-3 text-sm">
                  <span className="flex-1 min-w-0">{ruleSentence(t, ex.template, ex.params, tpl?.params)}</span>
                  <button className="btn btn-sm shrink-0" disabled={create.isPending} onClick={() => create.mutate(ex)}>
                    {t('hr_add_off')}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function RuleRow({ rule, templates, symbols, onError, clearError }: { rule: HoldingRule; templates: HoldingRuleTemplate[]; symbols: string[]; onError: (e: unknown) => void; clearError: () => void }) {
  const { t } = useI18n();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState(false);
  const patch = useMutation({ mutationFn: (body: Partial<HoldingRuleInput>) => api.patch<HoldingRule>(`/api/holding-rules/${rule.id}`, body), onMutate: clearError, onError, onSuccess: invalidate });
  const del = useMutation({ mutationFn: () => api.del<{ ok: boolean }>(`/api/holding-rules/${rule.id}`), onMutate: clearError, onError, onSuccess: invalidate });
  const tpl = templates.find((x) => x.id === rule.template);
  const sentence = ruleSentence(t, rule.template, rule.params, tpl?.params);
  if (editing && tpl) {
    return (
      <li className="py-3">
        <RuleForm
          templates={templates}
          symbols={symbols}
          initial={{ template: rule.template, params: rule.params, scopeSymbol: rule.scopeSymbol, enabled: rule.enabled }}
          fixedTemplate
          pending={patch.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(v) => {
            const body = ruleChanges(rule, v);
            if (!body) return setEditing(false);
            patch.mutate(body, { onSuccess: () => setEditing(false) });
          }}
        />
      </li>
    );
  }
  return (
    <li className="py-2.5 flex flex-col gap-1.5">
      <span className={`text-sm leading-snug ${rule.enabled ? '' : 'text-muted'}`}>{sentence}</span>
      {templateHelp(t, rule.template) && <span className="text-[11px] text-muted">{templateHelp(t, rule.template)}</span>}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="chip">
          {rule.scopeSymbol ? (
            <span className="num" dir="ltr">
              {rule.scopeSymbol}
            </span>
          ) : (
            t('hr_scope_all')
          )}
        </span>
        <label className="flex items-center gap-1 text-muted cursor-pointer">
          <input type="checkbox" checked={rule.enabled} disabled={patch.isPending} onChange={(e) => patch.mutate({ enabled: e.target.checked })} />
          {rule.enabled ? t('enabled') : t('hr_off')}
        </label>
        <span className="flex-1" />
        {tpl && (
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            {t('edit')}
          </button>
        )}
        <button className="btn btn-sm" disabled={del.isPending} onClick={() => window.confirm(t('hr_delete_confirm', { s: sentence })) && del.mutate()}>
          {t('delete')}
        </button>
      </div>
    </li>
  );
}

interface FormValue {
  template: string;
  params: Record<string, number>;
  scopeSymbol: string | null;
  enabled: boolean;
}

/** Add or edit: the condition (fixed when editing), its numbers with their ranges, the scope and on/off. */
function RuleForm({
  templates,
  symbols,
  initial,
  fixedTemplate = false,
  pending,
  onSubmit,
  onCancel,
}: {
  templates: HoldingRuleTemplate[];
  symbols: string[];
  initial: { template: string | null; params: Record<string, number> | null; scopeSymbol: string | null; enabled: boolean };
  fixedTemplate?: boolean;
  pending: boolean;
  onSubmit: (v: FormValue) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const choices = orderedTemplates(templates).filter((x) => isKnownTemplate(x.id) || x.id === initial.template);
  const [tplId, setTplId] = useState<string>(initial.template ?? choices[0]?.id ?? '');
  const tpl = templates.find((x) => x.id === tplId);
  // the text the form started with: an untouched field keeps the rule's exact number on save (keepUntouched)
  const [initialDraft] = useState<Record<string, string>>(() => (tpl ? draftOf(tpl.params, initial.params ?? undefined) : {}));
  const [draft, setDraft] = useState<Record<string, string>>(initialDraft);
  const [scope, setScope] = useState<string>(initial.scopeSymbol ?? '');
  const [enabled, setEnabled] = useState(initial.enabled);
  // a rule scoped to a symbol that is no longer held keeps its scope as an option
  const scopeOptions = initial.scopeSymbol && !symbols.includes(initial.scopeSymbol) ? [...symbols, initial.scopeSymbol] : symbols;
  const params = tpl ? parseParams(draft, tpl.params) : null;
  const preview = tpl && params ? ruleSentence(t, tpl.id, params, tpl.params) : null;
  return (
    <form
      className="card p-3 flex flex-col gap-3 text-sm bg-surface-2/40"
      onSubmit={(e) => {
        e.preventDefault();
        if (!tpl || !params) return;
        const kept = tpl.id === initial.template ? keepUntouched(params, draft, initialDraft, initial.params) : params;
        onSubmit({ template: tpl.id, params: kept, scopeSymbol: scope || null, enabled });
      }}
    >
      {!fixedTemplate && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('hr_choose')}</span>
          <select
            className="input"
            value={tplId}
            onChange={(e) => {
              const next = templates.find((x) => x.id === e.target.value);
              setTplId(e.target.value);
              setDraft(next ? draftOf(next.params) : {});
            }}
          >
            {choices.map((x) => (
              <option key={x.id} value={x.id}>
                {templateLabel(t, x)}
              </option>
            ))}
          </select>
        </label>
      )}
      {tpl && (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {tpl.params.map((spec) => (
            <ParamInput key={spec.key} spec={spec} template={tpl.id} value={draft[spec.key] ?? ''} onChange={(v) => setDraft({ ...draft, [spec.key]: v })} />
          ))}
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('hr_scope')}</span>
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">{t('hr_scope_all')}</option>
          {scopeOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('enabled')}
      </label>
      {tpl && templateHelp(t, tpl.id) && <p className="text-[11px] text-muted">{templateHelp(t, tpl.id)}</p>}
      {preview && <p className="text-xs leading-relaxed border-s-2 border-accent/60 ps-2">{preview}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-sm btn-primary" disabled={!params || pending}>
          {t('save')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

function ParamInput({ spec, template, value, onChange }: { spec: HoldingRuleParamSpec; template: string; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const bad = parseParam(value, spec) === null;
  const hint = t(spec.kind === 'int' ? 'hr_invalid_int' : 'hr_invalid', { min: spec.min, max: spec.max });
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">
        {paramLabel(t, spec.key, template)}
        {spec.kind === 'pct' ? ' (%)' : ''}
      </span>
      <input
        className={`input num ${bad ? 'border-neg' : ''}`}
        style={{ width: '7rem' }}
        dir="ltr"
        type="text"
        // a phone's number pad may have no minus sign: a range below zero gets the full keyboard
        inputMode={spec.min < 0 ? 'text' : spec.kind === 'int' ? 'numeric' : 'decimal'}
        value={value}
        aria-invalid={bad}
        title={hint}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className={`text-[11px] ${bad ? 'text-neg' : 'text-muted'}`}>{hint}</span>
    </label>
  );
}
