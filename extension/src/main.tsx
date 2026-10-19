import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError } from './api';
import { markCategory, markedRanges, removalScore, shouldMark, timestamp, totalDuration, usefulnessThresholdFor } from './policy';
import { previewAnalysis, previewVideo } from './preview';
import { getStored, removeStored, setStored } from './storage';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, videoKey, type Analysis, type Health, type Job, type Settings, type VideoMetadata } from './types';
import './styles.css';

const isPreview = import.meta.env.DEV && new URLSearchParams(location.search).get('preview') === '1';
const hasChrome = typeof chrome !== 'undefined' && Boolean(chrome.tabs);

function Logo() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M9 7v13a5 5 0 0 0 10 0V7M24 7v9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/><path d="M5 12h8M15 12h8" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>;
}

function ThresholdSlider({ id, label, value, onChange, min = 0 }: { id: string; label: string; value: number; onChange: (value: number) => void; min?: number }) {
  const percent = Math.round(value * 100);
  return <div className="threshold-control">
    <div className="confidence-heading"><label htmlFor={id}>{label}</label><output htmlFor={id}>{percent}<span>%</span></output></div>
    <input id={id} className="confidence-slider" type="range" min={min} max="100" step="1" value={percent} aria-valuetext={`${percent} percent`} onChange={event => onChange(Number(event.target.value) / 100)} style={{ '--range-fill': `${(percent - min) / (100 - min) * 100}%` } as React.CSSProperties} />
  </div>;
}

function App() {
  const [video, setVideo] = useState<VideoMetadata | null>(isPreview ? previewVideo : null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [health, setHealth] = useState<Health | null>(isPreview ? { status: 'ok', api_key_configured: true, model: 'jev · demo', version: 'demo' } : null);
  const [helperError, setHelperError] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [subject, setSubject] = useState(isPreview ? previewAnalysis.subject : '');
  const [analysis, setAnalysis] = useState<Analysis | null>(isPreview ? previewAnalysis : null);
  const [job, setJob] = useState<Job | null>(null);
  const [kept, setKept] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loadingCache, setLoadingCache] = useState(false);
  const [tabError, setTabError] = useState('');
  const subjectEdited = useRef(false);
  const videoRef = useRef(video?.video_id);
  videoRef.current = video?.video_id;

  const connect = async () => {
    if (isPreview) return;
    try { setHealth(await api.health()); setHelperError(''); }
    catch (cause) { setHealth(null); setHelperError(cause instanceof Error ? cause.message : 'Could not reach the local helper.'); }
  };

  useEffect(() => {
    void getStored<unknown>(SETTINGS_KEY, DEFAULT_SETTINGS).then(value => setSettings(normalizeSettings(value)));
    void connect();
    const timer = window.setInterval(() => void connect(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isPreview || !hasChrome) return;
    let alive = true;
    let latestRequest = 0;
    const update = async () => {
      const requestId = ++latestRequest;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined) return;
        let metadata: VideoMetadata | null = null;
        if (tab.url?.startsWith('https://www.youtube.com/') || tab.url?.startsWith('https://m.youtube.com/')) {
          try { metadata = await chrome.tabs.sendMessage(tab.id, { type: 'JEV_GET_VIDEO' }) as VideoMetadata | null; }
          catch {
            if (alive && requestId === latestRequest) setTabError('Reload this YouTube tab after installing or reloading the extension.');
          }
        }
        if (!alive || requestId !== latestRequest) return;
        setTabId(tab.id);
        setVideo(previous => previous?.video_id === metadata?.video_id && previous?.title === metadata?.title
          && previous?.duration === metadata?.duration ? previous : metadata);
        if (metadata) setTabError('');
      } catch { if (alive) setTabError('Could not read this tab. Open a YouTube watch page and try again.'); }
    };
    void update();
    const interval = window.setInterval(() => void update(), 1800);
    chrome.tabs.onActivated.addListener(update);
    return () => { alive = false; window.clearInterval(interval); chrome.tabs.onActivated.removeListener(update); };
  }, []);

  useEffect(() => {
    if (isPreview) return;
    setAnalysis(null); setKept([]); setJob(null); setError(''); setStarting(false); setShowAll(false);
    subjectEdited.current = false;
    setSubject(video?.title ?? '');
    if (!video) return;
    const videoId = video.video_id;
    let alive = true;
    setLoadingCache(true);
    void (async () => {
      try {
        const [savedAnalysis, savedKept, savedSubject, savedJob] = await Promise.all([
          getStored<Analysis | null>(videoKey(videoId, 'analysis'), null),
          getStored<string[]>(videoKey(videoId, 'kept'), []),
          getStored<string>(videoKey(videoId, 'subject'), ''),
          getStored<Job | null>(videoKey(videoId, 'job'), null),
        ]);
        if (!alive) return;
        setKept(savedKept);
        if (savedSubject) { subjectEdited.current = true; setSubject(savedSubject); }
        if (savedAnalysis?.video_id === videoId) {
          setAnalysis(savedAnalysis);
          if (!savedSubject) { subjectEdited.current = true; setSubject(savedAnalysis.subject); }
        }
        if (savedJob?.video_id === videoId && !['complete', 'failed'].includes(savedJob.status)) setJob(savedJob);
        try {
          const cached = await api.cached(videoId);
          if (alive && cached.video_id === videoId) {
            setAnalysis(cached);
            if (!savedSubject && !subjectEdited.current) { subjectEdited.current = true; setSubject(cached.subject); }
            await setStored(videoKey(videoId, 'analysis'), cached);
          }
        } catch (cause) {
          if (alive && cause instanceof ApiError && cause.status !== 404) setError(cause.message);
          // A stopped helper or a cache miss must not hide a previously saved analysis.
        }
      } catch (cause) { if (alive) setError(`Could not read local state: ${String(cause)}`); }
      finally { if (alive) setLoadingCache(false); }
    })();
    return () => { alive = false; };
  }, [video?.video_id]);

  useEffect(() => {
    // YouTube can render the new title after changing the watch URL.
    if (!isPreview && video?.title && !subjectEdited.current) setSubject(video.title);
  }, [video?.video_id, video?.title]);

  async function acceptJob(next: Job) {
    if (next.video_id !== videoRef.current) return;
    setJob(next);
    if (next.status === 'complete' && next.analysis?.video_id === next.video_id) {
      setAnalysis(next.analysis);
      setError('');
      await setStored(videoKey(next.video_id, 'analysis'), next.analysis);
      await removeStored(videoKey(next.video_id, 'job'));
    } else if (next.status === 'failed') {
      setError(next.error || 'Analysis failed. Check the helper terminal and try again.');
      await removeStored(videoKey(next.video_id, 'job'));
    } else {
      setError('');
      await setStored(videoKey(next.video_id, 'job'), next);
    }
  }

  useEffect(() => {
    if (!job || ['complete', 'failed'].includes(job.status)) return;
    let alive = true;
    let timeout = 0;
    const jobId = job.id;
    const poll = async () => {
      try {
        const next = await api.job(jobId);
        if (!alive) return;
        await acceptJob(next);
        if (!['complete', 'failed'].includes(next.status)) timeout = window.setTimeout(() => void poll(), 1400);
      } catch (cause) {
        if (!alive) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setJob(null);
          await removeStored(videoKey(job.video_id, 'job'));
          setError('The helper no longer has this job, possibly after a restart. Analyze the video again to retry.');
          return;
        }
        setError(`${cause instanceof Error ? cause.message : 'Could not refresh analysis.'} Reconnecting automatically.`);
        timeout = window.setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timeout); };
  }, [job?.id, video?.video_id]);

  async function analyze() {
    if (!video || starting || isPreview) return;
    const id = video.video_id;
    setStarting(true); setError('');
    try {
      let current = video;
      if (tabId !== null) {
        const fresh = await chrome.tabs.sendMessage(tabId, { type: 'JEV_GET_VIDEO' }) as VideoMetadata | null;
        if (!fresh || fresh.video_id !== id) throw new Error('The video changed. Wait for the panel to refresh, then try again.');
        current = fresh;
      }
      await setStored(videoKey(id, 'subject'), subject);
      const next = await api.analyze(current, subject, Boolean(analysis));
      if (videoRef.current === id) await acceptJob(next);
    } catch (cause) { if (videoRef.current === id) setError(cause instanceof Error ? cause.message : 'Could not start analysis.'); }
    finally { if (videoRef.current === id) setStarting(false); }
  }

  function updateSettings(patch: Partial<Settings>) {
    const next = normalizeSettings({ ...settings, ...patch });
    setSettings(next);
    void setStored(SETTINGS_KEY, next).catch(() => setError('Could not save settings to local storage.'));
  }

  async function toggleKeep(segmentId: string) {
    if (!video) return;
    const next = kept.includes(segmentId) ? kept.filter(id => id !== segmentId) : [...kept, segmentId];
    setKept(next);
    if (!isPreview) await setStored(videoKey(video.video_id, 'kept'), next);
  }

  async function seek(time: number) {
    if (isPreview) { setError(`Preview only: in YouTube this button seeks to ${timestamp(time)}.`); return; }
    if (tabId === null || !video) return;
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'JEV_SEEK', video_id: video.video_id, time });
      if (!result?.ok) setError('Cannot seek right now. Wait for any ad to finish, then try again.');
    } catch { setError('Reload the YouTube tab to reconnect the player.'); }
  }

  const busy = starting || Boolean(job && !['complete', 'failed'].includes(job.status));
  const ranges = analysis ? markedRanges(analysis.segments, settings, kept) : [];
  const duration = totalDuration(ranges);
  const durationKnown = video?.duration ?? analysis?.segments.at(-1)?.end ?? 0;
  const markedCount = analysis?.segments.filter(segment => shouldMark(segment, settings, kept)).length ?? 0;
  const visibleSegments = analysis?.segments.filter(segment => showAll || shouldMark(segment, settings, kept) || kept.includes(segment.id)) ?? [];
  const ready = Boolean(health?.api_key_configured);
  const progress = job?.progress.total ? Math.round(job.progress.completed / job.progress.total * 100) : 0;

  return <div className="app">
    {isPreview && <div className="demo-banner">UI PREVIEW · Illustrative scores, no Jev analysis</div>}
    <header className="topbar">
      <div className="brand"><Logo /><span className="wordmark">jev<span className="wordmark-dot">.</span></span></div>
      <span className="mode-pill"><span className="mode-dot" />Mark only</span>
    </header>

    <main>
      <div className={`connection ${health ? (ready ? 'connected' : 'needs-key') : 'disconnected'}`}>
        <span className="connection-dot" /><div><strong>{health ? ready ? 'Local helper connected' : 'Jev key needed' : 'Local helper offline'}</strong>{!ready && <span>{health ? 'Add JEV_API_KEY to the project .env, then restart.' : 'Start the helper on 127.0.0.1:8765'}</span>}</div>
        {!isPreview && <button className="icon-button" onClick={() => void connect()} aria-label="Reconnect to local helper" title="Reconnect">↻</button>}
      </div>

      {!video ? <section className="empty-state"><h2>No video selected</h2><p>{tabError || 'Open a YouTube video in this window to analyze it.'}</p>{!hasChrome && <p className="fine-print">Load extension/dist as an unpacked Chrome extension. For a UI demo, open /sidepanel.html?preview=1 in the dev server.</p>}</section> : <>
        <section className="video-card">
          <h2>{video.title || 'YouTube video'}</h2>
          <span className="video-length">{video.duration ? timestamp(video.duration) : 'Duration unavailable'}</span>
        </section>

        <section className="settings-section">
          <div className="section-heading"><h2>Settings</h2></div>
          <label className="field-label" htmlFor="subject">Video subject</label>
          <textarea id="subject" rows={2} value={subject} maxLength={1000} onChange={event => { subjectEdited.current = true; setSubject(event.target.value); }} placeholder="What is this video about?" />
          <ThresholdSlider id="confidence" label="Confidence to mark" value={settings.threshold} min={50} onChange={threshold => updateSettings({ threshold })} />
          <div className="slider-endpoints"><span>More candidates</span><span>More certain</span></div>
          <div className="category-options">
            <label className="toggle-row"><span><i className="legend-dot promotion" />Promotions</span><input type="checkbox" role="switch" checked={settings.promotions} onChange={event => updateSettings({ promotions: event.target.checked })} /><span className="switch" aria-hidden="true" /></label>
            <label className="toggle-row"><span><i className="legend-dot tangent" />Tangents</span><input type="checkbox" role="switch" checked={settings.tangents} onChange={event => updateSettings({ tangents: event.target.checked })} /><span className="switch" aria-hidden="true" /></label>
          </div>
          <button className="advanced-button" aria-expanded={showAdvanced} aria-controls="advanced-settings" onClick={() => setShowAdvanced(!showAdvanced)}>Advanced <span aria-hidden="true">{showAdvanced ? '−' : '+'}</span></button>
          <div id="advanced-settings" className="advanced-settings" hidden={!showAdvanced}>
            <p className="field-hint">Higher values require stronger evidence to keep a passage.</p>
            <ThresholdSlider id="promotion-usefulness" label="Keep promotions if useful" value={settings.promotionUsefulnessThreshold} onChange={promotionUsefulnessThreshold => updateSettings({ promotionUsefulnessThreshold })} />
            <ThresholdSlider id="other-usefulness" label="Keep other passages if useful" value={settings.usefulnessThreshold} onChange={usefulnessThreshold => updateSettings({ usefulnessThreshold })} />
            <ThresholdSlider id="necessary-context" label="Keep necessary context" value={settings.contextThreshold} onChange={contextThreshold => updateSettings({ contextThreshold })} />
          </div>
          <button className="analyze-button" disabled={!ready || busy || loadingCache || isPreview} onClick={() => void analyze()}>{busy && <span className="spinner" />}{busy ? job?.status === 'fetching' ? 'Getting the transcript…' : 'Analyzing the video…' : analysis ? 'Analyze again' : 'Analyze this video'}</button>
          {busy && <div className="job-progress" role="status"><div className="progress-track"><span style={{ width: `${Math.max(5, progress)}%` }} /></div><span>{job?.progress.total ? `${job.progress.completed} / ${job.progress.total} passages` : 'Preparing timestamped passages'}<span>{progress}%</span></span></div>}
        </section>

        {error && <div className="error-message" role="alert"><span>!</span><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}

        <section className="results-section">
          <div className="section-heading"><h2>Timeline</h2></div>
          {analysis ? <>
            <div className="summary"><div><span className="stat-label">Marked duration</span><strong>{timestamp(duration)}<small> / {timestamp(durationKnown)}</small></strong></div><span className="count-pill">{markedCount} passage{markedCount === 1 ? '' : 's'}</span></div>
            <div className="mini-timeline" role="img" aria-label={`${markedCount} marked passages, ${timestamp(duration)} total`}>
              {ranges.map((range, index) => <span key={index} className={range.category} style={{ left: `${durationKnown ? range.start / durationKnown * 100 : 0}%`, width: `${durationKnown ? (range.end - range.start) / durationKnown * 100 : 0}%` }} />)}
            </div>
            <div className="timeline-labels"><span>0:00</span><span>{timestamp(durationKnown)}</span></div>
            <div className="result-controls"><label><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} />Show all passages</label></div>
            <div className="segment-list">
              {visibleSegments.length === 0 && <div className="no-marks"><h3>No passages marked</h3><p>Adjust the thresholds or show all passages to review the scores.</p></div>}
              {visibleSegments.map(segment => {
                const marked = shouldMark(segment, settings, kept);
                const isKept = kept.includes(segment.id);
                const category = markCategory(segment, settings);
                return <article className={`segment ${marked ? category : 'preserved'}`} key={segment.id}>
                  <div className="segment-top"><button className="time-button" onClick={() => void seek(segment.start)} title="Seek to this passage">▶ {timestamp(segment.start)}<span>— {timestamp(segment.end)}</span></button><span className={`segment-badge ${marked ? category : ''}`}>{isKept ? 'Kept by you' : marked ? category === 'promotion' ? 'Promotion' : 'Tangent' : 'Preserved'}</span></div>
                  <p className="segment-text">{segment.text}</p>
                  <div className="scores"><span title="Probability that the passage provides useful subject-related information">Useful <b>{Math.round(segment.relevance * 100)}%</b></span><span title="Probability that this passage is promotional">Promo <b>{Math.round(segment.promotion * 100)}%</b></span><span title="Probability that the passage is unrelated to the subject">Tangent <b>{Math.round(segment.tangent * 100)}%</b></span><span title="Probability that nearby useful material needs this passage">Context <b>{Math.round(segment.context_needed * 100)}%</b></span></div>
                  <div className="segment-footer"><span>{isKept ? 'Kept manually' : marked ? `${Math.round(removalScore(segment, settings) * 100)}% removal score` : !settings.promotions && !settings.tangents ? 'Marking disabled' : segment.relevance >= usefulnessThresholdFor(segment, settings) ? 'Useful content preserved' : segment.context_needed >= settings.contextThreshold ? 'Needed for context' : 'Below marking threshold'}</span><button className="keep-button" onClick={() => void toggleKeep(segment.id).catch(() => setError('Could not save your keep choice.'))}>{isKept ? 'Undo keep' : '+ Keep'}</button></div>
                </article>;
              })}
            </div>
            <div className="usage-card"><div><span className="usage-label">Analysis usage</span><span className="usage-cost">${analysis.usage.estimated_cost_usd.toFixed(5)} <small>estimated</small></span></div><div className="usage-detail"><span>{analysis.usage.input_tokens.toLocaleString()} input tokens · {analysis.usage.requests} requests</span><span>{analysis.model}</span></div></div>
            <p className="provenance">{analysis.transcript_source} · Text analysis</p>
          </> : <div className="pending-state">{loadingCache ? <p>Checking saved analysis…</p> : <p>{busy ? 'Analyzing the transcript…' : 'Analyze this video to see proposed marks.'}</p>}</div>}
        </section>
      </>}
      {!video && helperError && <p className="fine-print helper-hint">{helperError}</p>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
