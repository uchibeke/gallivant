// Offline metrics over captured, independently adjudicated review outputs.
// Seed labels alone cannot manufacture live judgement or baseline evidence.
export function evaluateReviews(corpus, runs, baseline) {
  if (corpus?.version !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error("versioned held-out corpus required");
  const score = records => {
    if (!Array.isArray(records) || records.length !== corpus.cases.length || new Set(records.map(r=>r.caseId)).size !== records.length) throw new Error("one recorded result per held-out case is required");
    let detected=0, defects=0, falsePositives=0, clean=0, latencyMs=0, costUsd=0, unknownCost=0;
    for (const c of corpus.cases) {
      const r=records.find(r=>r.caseId===c.id);
      if (!r || !r.evidence || !["clear","findings","failed","incomplete"].includes(r.verdict) || !Array.isArray(r.detectedDefects) || !Number.isFinite(r.latencyMs) || r.latencyMs<0 || r.costUsd!==null && (!Number.isFinite(r.costUsd) || r.costUsd<0)) throw new Error("each result needs verifiable evidence, adjudicated defects, latency and explicit cost/unknown");
      const accepted=new Set(r.detectedDefects);
      if (accepted.size!==r.detectedDefects.length || [...accepted].some(id=>!c.defects.includes(id)) || r.verdict!=="findings" && accepted.size) throw new Error("detection IDs must be independently adjudicated against the held-out case");
      defects+=c.defects.length; detected+=accepted.size;
      if (!c.defects.length) { clean++; if (r.verdict==="findings") falsePositives++; }
      latencyMs+=r.latencyMs;
      if (r.costUsd===null) unknownCost++; else costUsd+=r.costUsd;
    }
    return { detected, defects, defectDetection: defects?detected/defects:null, falsePositives, clean, falsePositiveRate:clean?falsePositives/clean:null,
      meanLatencyMs:latencyMs/records.length, knownSpendUsd:costUsd, unknownSpendRuns:unknownCost, failures:records.filter(r=>["failed","incomplete"].includes(r.verdict)).length };
  };
  const measured = score(runs);
  if (!baseline) return { status:"baseline-missing", firstParty:measured, baseline:null, defaultChangeJustified:false };
  if (!["external-review","human-reviewed"].includes(baseline.kind) || !baseline.evidence) throw new Error("an external-review or human-reviewed baseline evidence pointer is required");
  return { status:"measured", firstParty:measured, baseline:{kind:baseline.kind,evidence:baseline.evidence,...score(baseline.runs)}, defaultChangeJustified:false };
}
