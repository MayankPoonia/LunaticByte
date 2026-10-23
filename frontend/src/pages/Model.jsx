// Model information: version, evaluation metrics from the training run, segment check, and genuine
// labelled frauds that the rules baseline misses but the model scores highly (re-scored live).
import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useApi } from '../lib/session';
import { dateTime, num, pct } from '../lib/format';
import { ErrorBanner, KeyValue, Loading, PageHeader, ScoreValue, Section, Stat, TableWrap } from '../components/ui';

export default function Model() {
  const info = useApi('/model/info');
  const [rescored, setRescored] = useState({});
  const [error, setError] = useState('');

  async function rescore(e) {
    setError('');
    try {
      const { data } = await api('/model/score', { method: 'POST', body: { features: e.features } });
      setRescored((r) => ({ ...r, [e.txn_id]: data.fraud_score }));
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (info.error) {
    return (
      <div>
        <PageHeader title="Model" />
        <ErrorBanner error={info.error.status === 503 ? 'The model service is unavailable. Authorisations fall back to rules-only decisions (MODEL_UNAVAILABLE).' : info.error} onRetry={info.reload} />
      </div>
    );
  }
  if (!info.data) return <Loading />;
  const m = info.data;
  const x = m.metrics.xgboost;
  const b = m.metrics.baseline;
  const rows = [['XGBoost at 0.70', x.at_step_up_threshold], ['XGBoost at 0.90', x.at_block_threshold], [`XGBoost at cost-optimal ${m.thresholds.cost_optimal_validation}`, x.at_cost_threshold],
    ['Baseline: any rule', b.flag_any_rule], ['Baseline: score 100', b.score_100]];

  return (
    <div>
      <PageHeader title="Model" subtitle={`XGBoost ${m.model_version}, trained ${dateTime(m.trained_at)}`} />
      <ErrorBanner error={error} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="PR-AUC (test)" value={num(x.pr_auc, 4)} hint={`baseline ${num(b.pr_auc, 4)} (${num(x.pr_auc / b.pr_auc, 2)}x)`} />
        <Stat label="ROC-AUC (test)" value={num(x.roc_auc, 4)} hint={`baseline ${num(b.roc_auc, 4)}`} />
        <Stat label="Isolation Forest ROC-AUC" value={num(m.metrics.isolation_forest.roc_auc, 4)} hint="second detector, evaluation only" />
        <Stat label="Inference latency" value={`${num(m.latency.p95_ms, 2)} ms`} hint="p95 in-process, with SHAP" />
      </div>
      <Section className="mt-6" title="Training">
        <KeyValue items={[['Dataset', m.dataset], ['Split', m.split], ['Seed', m.seed], ['Rows', `${m.rows.train} train / ${m.rows.test} test`],
          ['Fraud rate', `${pct(m.fraud_rate.train, 2)} train, ${pct(m.fraud_rate.test, 2)} test`], ['Class imbalance', `scale_pos_weight ${m.scale_pos_weight.chosen} (${num(m.scale_pos_weight.value)})`],
          ['Decision thresholds', `step-up ${m.thresholds.step_up}, block ${m.thresholds.block}`], ['Features', m.features.join(', ')]]} />
      </Section>
      <Section className="mt-6" title="Test-period operating points">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Operating point</th><th>Precision</th><th>Recall</th><th>TP</th><th>FP</th><th>FN</th><th>TN</th><th>Flag rate</th></tr></thead>
            <tbody>{rows.map(([k, r]) => <tr key={k}><td>{k}</td><td>{num(r.precision, 4)}</td><td>{num(r.recall, 4)}</td><td>{r.tp}</td><td>{r.fp}</td><td>{r.fn}</td><td>{r.tn}</td><td>{pct(r.flag_rate, 2)}</td></tr>)}</tbody>
          </table>
        </TableWrap>
      </Section>
      <Section className="mt-6" title="Friction on genuine transactions by segment">
        <TableWrap>
          <table className="table">
            <thead><tr><th>Dimension</th><th>Segment</th><th>Genuine transactions</th><th>Model friction</th><th>Ratio</th><th>System friction</th><th>Ratio</th></tr></thead>
            <tbody>{m.segments.map((s) => (
              <tr key={s.dimension + s.segment}><td>{s.dimension}</td><td>{s.segment}</td><td>{s.genuine_txns}</td><td>{pct(s.model_friction_rate, 2)}</td>
                <td className={s.model_friction_rate_ratio < 0.8 ? 'text-amber-700' : ''}>{num(s.model_friction_rate_ratio)}</td><td>{pct(s.system_friction_rate, 2)}</td>
                <td className={s.system_friction_rate_ratio < 0.8 ? 'text-amber-700' : ''}>{num(s.system_friction_rate_ratio)}</td></tr>
            ))}</tbody>
          </table>
        </TableWrap>
        <p className="mt-3 text-xs text-slate-500">Ratio = lowest rate / highest rate in the dimension; below 0.8 is explained in ml/model_card.md.</p>
      </Section>
      <Section className="mt-6" title="Labelled frauds the rules miss but the model catches">
        {m.rules_missed_examples.length === 0 ? (
          <p className="muted">No fraud in the labelled test period has a rules baseline score of 0 together with a model score of 0.70 or more, so there is no such example to show for this model.</p>
        ) : (
          <TableWrap>
            <table className="table">
              <thead><tr><th>Labelled txn</th><th>Baseline score</th><th>Model score (training run)</th><th>Model score (live)</th><th>Top factors</th><th /></tr></thead>
              <tbody>{m.rules_missed_examples.map((e) => (
                <tr key={e.txn_id}><td className="mono">{e.txn_id}</td><td>{e.baseline_score}</td><td><ScoreValue score={e.fraud_score} /></td>
                  <td>{rescored[e.txn_id] === undefined ? '-' : <ScoreValue score={rescored[e.txn_id]} />}</td>
                  <td className="whitespace-normal text-xs">{e.top_factors.map((f) => f.text).join('; ')}</td>
                  <td><button type="button" className="btn-secondary btn-sm" onClick={() => rescore(e)}>Score now</button></td></tr>
              ))}</tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </div>
  );
}
