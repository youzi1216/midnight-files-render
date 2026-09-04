'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

app.use(
  express.json({
    limit: '50mb'
  })
);

// ============================================================
// CONFIG
// ============================================================

const PORT =
  Number(process.env.PORT || 3000);

const SERVER_VERSION =
  'midnight-files-render-v2.2.0-universal';

const HARD_TIMEOUT_MINUTES =
  60;

const HARD_TIMEOUT_MS =
  HARD_TIMEOUT_MINUTES *
  60 *
  1000;

const EXPECTED_SHOTS_PER_SCENE =
  2;

const MIN_SCENES =
  1;

const MAX_SCENES =
  40;

const VISUAL_RENDER_CONCURRENCY =
  Math.max(1, Math.min(4, Number(process.env.VISUAL_RENDER_CONCURRENCY || 2)));

const MIN_AUDIO_PARTS =
  3;

const MAX_AUDIO_PARTS =
  6;

const DOWNLOAD_MAX_ATTEMPTS =
  4;

const DOWNLOAD_TIMEOUT_MS =
  90000;

const MEDIA_DURATION_TOLERANCE_SECONDS =
  1.25;

const ROOT_DIR =
  path.join(
    os.tmpdir(),
    'midnight-files-render'
  );

const JOBS_DIR =
  path.join(
    ROOT_DIR,
    'jobs'
  );

const OUTPUT_DIR =
  path.join(
    ROOT_DIR,
    'outputs'
  );

const jobs =
  new Map();


// ============================================================
// HELPERS
// ============================================================

function cleanText(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .replace(/^\uFEFF/, '')
    .trim();
}


function safeNumber(
  value,
  fallback
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function safeBoolean(
  value,
  fallback = false
) {

  if (
    value === true ||
    value === false
  ) {
    return value;
  }

  return fallback;
}


function safeObject(value) {

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value;
  }

  return {};
}


function safeArray(value) {

  return Array.isArray(value)
    ? value
    : [];
}


function nowIso() {

  return new Date()
    .toISOString();
}


function createJobId() {

  return crypto
    .randomUUID();
}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function roundDuration(value) {

  return Number(
    Number(value)
      .toFixed(6)
  );
}


function escapeDrawtext(value) {

  return cleanText(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}


// ============================================================
// DIRECTORIES
// ============================================================

async function ensureDirectories() {

  await fsp.mkdir(
    JOBS_DIR,
    {
      recursive: true
    }
  );

  await fsp.mkdir(
    OUTPUT_DIR,
    {
      recursive: true
    }
  );
}


// ============================================================
// JOB HELPERS
// ============================================================

function publicJob(job) {

  if (!job) {
    return null;
  }

  return {

    job_id:
      job.job_id,

    status:
      job.status,

    progress:
      job.progress,

    current_step:
      job.current_step,

    created_at:
      job.created_at,

    started_at:
      job.started_at,

    completed_at:
      job.completed_at,

    elapsed_seconds:
      job.started_at
        ? Math.floor(
            (
              Date.now() -
              new Date(
                job.started_at
              ).getTime()
            ) /
            1000
          )
        : 0,

    total_visuals:
      job.total_visuals,

    total_audio_parts:
      job.total_audio_parts,

    narration_duration:
      job.narration_duration ??
      null,

    final_audio_duration:
      job.final_audio_duration ??
      null,

    combined_video_duration:
      job.combined_video_duration ??
      null,

    final_video_duration:
      job.final_video_duration ??
      null,

    opening_duration:
      job.opening_duration ??
      null,

    ending_duration:
      job.ending_duration ??
      null,

    scene_timeline:
      job.scene_timeline ??
      null,

    timeline_validation:
      job.timeline_validation ??
      null,

    audio_part_durations:
      job.audio_part_durations ??
      null,

    output_size_bytes:
      job.output_size_bytes ??
      null,

    error:
      job.error ??
      null,

    failed_scene_number:
      job.failed_scene_number ??
      null,

    failed_shot_index:
      job.failed_shot_index ??
      null,

    failed_audio_part:
      job.failed_audio_part ??
      null,

    failed_url:
      job.failed_url ??
      null,

    timeout:
      job.timeout ??
      false,

    max_render_minutes:
      HARD_TIMEOUT_MINUTES,

    download_url:
      job.status === 'completed'
        ? `/download/${job.job_id}`
        : null
  };
}


function updateJob(
  jobId,
  patch
) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  // Once timed out, no background process may revive the job.
  if (
    job.timeout === true &&
    patch.status === 'completed'
  ) {
    return;
  }

  Object.assign(
    job,
    patch
  );
}


function assertJobActive(jobId) {

  const job =
    jobs.get(jobId);

  if (!job) {

    const error =
      new Error(
        'Render job no longer exists'
      );

    error.isCancelled =
      true;

    throw error;
  }

  if (
    job.abort_controller
      ?.signal
      ?.aborted
  ) {

    const error =
      new Error(
        job.timeout
          ? `Render hard timeout after ${HARD_TIMEOUT_MINUTES} minutes`
          : 'Render job aborted'
      );

    error.isTimeout =
      Boolean(
        job.timeout
      );

    error.isCancelled =
      true;

    throw error;
  }
}


// ============================================================
// CHILD PROCESS MANAGEMENT
// ============================================================

function registerChild(
  jobId,
  child
) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  if (
    !(job.active_children instanceof Set)
  ) {
    job.active_children =
      new Set();
  }

  job.active_children
    .add(child);
}


function unregisterChild(
  jobId,
  child
) {

  const job =
    jobs.get(jobId);

  if (
    !job ||
    !(job.active_children instanceof Set)
  ) {
    return;
  }

  job.active_children
    .delete(child);
}


function killActiveChildren(jobId) {

  const job =
    jobs.get(jobId);

  if (
    !job ||
    !(job.active_children instanceof Set)
  ) {
    return;
  }

  for (
    const child of
    job.active_children
  ) {

    try {

      if (
        child &&
        !child.killed
      ) {

        child.kill(
          'SIGKILL'
        );
      }

    } catch (_) {}
  }

  job.active_children
    .clear();
}


// ============================================================
// PROCESS
// ============================================================

function runProcess(
  jobId,
  command,
  args,
  options = {}
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      try {

        assertJobActive(
          jobId
        );

      } catch (error) {

        reject(error);

        return;
      }

      const job =
        jobs.get(jobId);

      const signal =
        job
          ?.abort_controller
          ?.signal;

      let settled =
        false;

      const child =
        spawn(
          command,
          args,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ],
            ...options
          }
        );

      registerChild(
        jobId,
        child
      );

      let stdout = '';
      let stderr = '';

      const cleanup =
        () => {

          unregisterChild(
            jobId,
            child
          );

          if (
            signal &&
            abortHandler
          ) {

            signal.removeEventListener(
              'abort',
              abortHandler
            );
          }
        };


      const finishReject =
        error => {

          if (settled) {
            return;
          }

          settled =
            true;

          cleanup();

          reject(error);
        };


      const finishResolve =
        result => {

          if (settled) {
            return;
          }

          settled =
            true;

          cleanup();

          resolve(result);
        };


      const abortHandler =
        () => {

          try {

            if (
              !child.killed
            ) {

              child.kill(
                'SIGKILL'
              );
            }

          } catch (_) {}

          const error =
            new Error(
              jobs.get(jobId)
                ?.timeout
                ? `Render hard timeout after ${HARD_TIMEOUT_MINUTES} minutes`
                : 'Render process aborted'
            );

          error.isTimeout =
            Boolean(
              jobs.get(jobId)
                ?.timeout
            );

          error.isCancelled =
            true;

          finishReject(
            error
          );
        };


      if (signal) {

        if (signal.aborted) {

          abortHandler();

          return;
        }

        signal.addEventListener(
          'abort',
          abortHandler,
          {
            once: true
          }
        );
      }


      child.stdout.on(
        'data',
        chunk => {

          stdout +=
            chunk.toString();

          if (
            stdout.length >
            20000
          ) {

            stdout =
              stdout.slice(
                -20000
              );
          }
        }
      );


      child.stderr.on(
        'data',
        chunk => {

          stderr +=
            chunk.toString();

          if (
            stderr.length >
            30000
          ) {

            stderr =
              stderr.slice(
                -30000
              );
          }
        }
      );


      child.on(
        'error',
        error => {

          finishReject(
            error
          );
        }
      );


      child.on(
        'close',
        code => {

          if (settled) {
            return;
          }

          if (
            signal?.aborted
          ) {

            abortHandler();

            return;
          }

          if (
            code === 0
          ) {

            finishResolve({
              stdout,
              stderr
            });

            return;
          }

          finishReject(
            new Error(
              `${command} exited with code ${code}\n${stderr}`
            )
          );
        }
      );
    }
  );
}


// ============================================================
// DOWNLOAD
// ============================================================

function shouldRetryHttpStatus(
  status
) {

  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}


async function downloadFile({
  jobId,
  url,
  destination,
  type,
  sceneNumber = null,
  shotIndex = null,
  partIndex = null
}) {

  const cleanUrl =
    cleanText(url);

  if (!cleanUrl) {

    throw new Error(
      `${type} download URL is empty`
    );
  }

  let lastError =
    null;

  for (
    let attempt = 1;
    attempt <=
    DOWNLOAD_MAX_ATTEMPTS;
    attempt++
  ) {

    assertJobActive(
      jobId
    );

    const job =
      jobs.get(jobId);

    const controller =
      new AbortController();

    let timedOut =
      false;

    const timeoutHandle =
      setTimeout(
        () => {

          timedOut =
            true;

          controller.abort();

        },
        DOWNLOAD_TIMEOUT_MS
      );

    const parentAbort =
      () => {

        try {
          controller.abort();
        } catch (_) {}
      };

    if (
      job
        ?.abort_controller
        ?.signal
    ) {

      if (
        job.abort_controller
          .signal
          .aborted
      ) {

        clearTimeout(
          timeoutHandle
        );

        assertJobActive(
          jobId
        );
      }

      job.abort_controller
        .signal
        .addEventListener(
          'abort',
          parentAbort,
          {
            once: true
          }
        );
    }

    try {

      const response =
        await fetch(
          cleanUrl,
          {
            redirect:
              'follow',

            signal:
              controller.signal,

            headers: {
              'User-Agent':
                'Midnight-Files-Render/2.1'
            }
          }
        );

      if (!response.ok) {

        const error =
          new Error(
            `${type} download failed: HTTP ${response.status} ${response.statusText}`
          );

        error.httpStatus =
          response.status;

        throw error;
      }

      const contentType =
        cleanText(
          response.headers.get(
            'content-type'
          )
        )
          .toLowerCase();

      if (
        contentType.includes(
          'text/html'
        )
      ) {

        const error =
          new Error(
            `${type} download returned HTML instead of media. Check Google Drive sharing permission.`
          );

        error.noRetry =
          true;

        throw error;
      }

      const buffer =
        Buffer.from(
          await response
            .arrayBuffer()
        );

      if (
        buffer.length <
        100
      ) {

        const error =
          new Error(
            `${type} download file is unexpectedly small (${buffer.length} bytes)`
          );

        throw error;
      }

      await fsp.writeFile(
        destination,
        buffer
      );

      clearTimeout(
        timeoutHandle
      );

      job
        ?.abort_controller
        ?.signal
        ?.removeEventListener(
          'abort',
          parentAbort
        );

      return {
        bytes:
          buffer.length,

        content_type:
          contentType,

        attempts:
          attempt
      };

    } catch (error) {

      clearTimeout(
        timeoutHandle
      );

      job
        ?.abort_controller
        ?.signal
        ?.removeEventListener(
          'abort',
          parentAbort
        );

      if (
        job
          ?.abort_controller
          ?.signal
          ?.aborted
      ) {

        assertJobActive(
          jobId
        );
      }

      const wrapped =
        new Error(
          timedOut
            ? `${type} download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s`
            : `${type} download error: ${error.message}`
        );

      wrapped.failedUrl =
        cleanUrl;

      wrapped.sceneNumber =
        sceneNumber;

      wrapped.shotIndex =
        shotIndex;

      wrapped.partIndex =
        partIndex;

      wrapped.httpStatus =
        error.httpStatus ??
        null;

      lastError =
        wrapped;

      const retryable =
        !error.noRetry &&
        (
          timedOut ||
          !Number.isFinite(
            error.httpStatus
          ) ||
          shouldRetryHttpStatus(
            error.httpStatus
          )
        );

      if (
        !retryable ||
        attempt >=
          DOWNLOAD_MAX_ATTEMPTS
      ) {

        throw wrapped;
      }

      const backoffMs =
        Math.min(
          8000,
          1000 *
          Math.pow(
            2,
            attempt - 1
          )
        );

      await sleep(
        backoffMs
      );
    }
  }

  throw (
    lastError ||
    new Error(
      `${type} download failed`
    )
  );
}


// ============================================================
// FFPROBE
// ============================================================

async function getMediaDuration(
  jobId,
  filePath
) {

  const result =
    await runProcess(
      jobId,
      'ffprobe',
      [
        '-v',
        'error',

        '-show_entries',
        'format=duration',

        '-of',
        'default=noprint_wrappers=1:nokey=1',

        filePath
      ]
    );

  const duration =
    Number(
      cleanText(
        result.stdout
      )
    );

  if (
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {

    throw new Error(
      `Unable to determine media duration: ${filePath}`
    );
  }

  return duration;
}


// ============================================================
// FONT
// ============================================================

async function detectFont() {

  const candidates = [

    process.env
      .CJK_FONT_PATH,

    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',

    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',

    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',

    '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',

    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

  ].filter(Boolean);

  for (
    const candidate of
    candidates
  ) {

    try {

      await fsp.access(
        candidate
      );

      return candidate;

    } catch (_) {}
  }

  return '';
}


// ============================================================
// DRAW TEXT
// ============================================================

function drawTextFilter({
  text,
  fontFile,
  fontSize,
  x,
  y,
  fontColor = 'white',
  box = true,
  boxColor = 'black@0.48',
  boxBorder = 14,
  enable = ''
}) {

  const value =
    escapeDrawtext(
      text
    );

  if (!value) {
    return '';
  }

  const escapedFont =
    String(fontFile)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'");

  const args = [

    'drawtext=',

    `fontfile='${escapedFont}'`,

    `:text='${value}'`,

    `:fontsize=${fontSize}`,

    `:fontcolor=${fontColor}`,

    `:x=${x}`,

    `:y=${y}`
  ];

  if (box) {

    args.push(
      ':box=1',

      `:boxcolor=${boxColor}`,

      `:boxborderw=${boxBorder}`
    );
  }

  if (enable) {

    args.push(
      `:enable='${enable}'`
    );
  }

  return args.join('');
}


// ============================================================
// SETTINGS
// ============================================================

function normalizeRenderSettings(
  input
) {

  const source =
    safeObject(
      input
    );

  const minimumShotDuration =
    Math.max(
      0.5,
      safeNumber(
        source.minimum_shot_duration,
        3.5
      )
    );

  const maximumShotDuration =
    Math.max(
      minimumShotDuration,
      safeNumber(
        source.maximum_shot_duration,
        45
      )
    );

  return {

    width:
      Math.max(
        640,
        Math.min(
          1920,
          Math.round(
            safeNumber(
              source.width,
              1280
            )
          )
        )
      ),

    height:
      Math.max(
        360,
        Math.min(
          1080,
          Math.round(
            safeNumber(
              source.height,
              720
            )
          )
        )
      ),

    fps:
      Math.max(
        20,
        Math.min(
          30,
          Math.round(
            safeNumber(
              source.fps,
              24
            )
          )
        )
      ),

    preset:
      [
        'ultrafast',
        'superfast',
        'veryfast',
        'faster',
        'fast'
      ].includes(
        source.preset
      )
        ? source.preset
        : 'ultrafast',

    crf:
      Math.max(
        18,
        Math.min(
          28,
          Math.round(
            safeNumber(
              source.crf,
              24
            )
          )
        )
      ),

    threads:
      Math.max(
        1,
        Math.min(
          4,
          Math.round(
            safeNumber(
              source.threads,
              2
            )
          )
        )
      ),

    audio_bitrate:
      cleanText(
        source.audio_bitrate
      ) ||
      '160k',

    video_codec:
      'libx264',

    audio_codec:
      'aac',

    pixel_format:
      'yuv420p',

    timing_mode:
      cleanText(
        source.timing_mode
      ) ||
      'audio_driven_scene_weighted',

    scene_timing_basis:
      cleanText(
        source.scene_timing_basis
      ) ||
      'narration_char_count',

    minimum_shot_duration:
      minimumShotDuration,

    maximum_shot_duration:
      maximumShotDuration,

    hard_timeout_seconds:
      Math.max(
        60,
        Math.min(
          HARD_TIMEOUT_MINUTES *
          60,
          Math.round(
            safeNumber(
              source.hard_timeout_seconds,
              HARD_TIMEOUT_MINUTES *
              60
            )
          )
        )
      )
  };
}


// ============================================================
// PRESENTATION
// ============================================================

function normalizePresentation(
  input,
  project = {}
) {

  const source =
    safeObject(
      input
    );

  const opening =
    safeObject(
      source.opening_disclaimer
    );

  const reconstruction =
    safeObject(
      source.reconstruction_overlay
    );

  const info =
    safeObject(
      source.info_card
    );

  const theory =
    safeObject(
      source.theory_overlay
    );

  const ending =
    safeObject(
      source.ending_card
    );

  return {

    opening_disclaimer: {

      enabled:
        safeBoolean(
          opening.enabled,
          true
        ),

      duration:
        Math.max(
          1,
          Math.min(
            6,
            safeNumber(
              opening.duration,
              2.5
            )
          )
        ),

      line_1:
        cleanText(
          opening.line_1
        ) ||
        cleanText(
          project.opening_disclaimer
        ) ||
        '本集內容根據公開案件資料整理',

      line_2:
        cleanText(
          opening.line_2
        ) ||
        cleanText(
          project.reconstruction_disclaimer
        ) ||
        '部分畫面為 AI 情境重建，非事件原始影像'
    },


    reconstruction_overlay: {

      enabled:
        safeBoolean(
          reconstruction.enabled,
          true
        ),

      text:
        cleanText(
          reconstruction.text
        ) ||
        'AI 情境重建'
    },


    info_card: {

      enabled:
        safeBoolean(
          info.enabled,
          true
        ),

      show_date:
        safeBoolean(
          info.show_date,
          true
        ),

      show_location:
        safeBoolean(
          info.show_location,
          true
        ),

      max_duration:
        Math.max(
          1,
          Math.min(
            8,
            safeNumber(
              info.max_duration,
              4
            )
          )
        )
    },


    theory_overlay: {

      enabled:
        safeBoolean(
          theory.enabled,
          true
        ),

      default_title:
        cleanText(
          theory.default_title
        ) ||
        '官方調查推測',

      default_disclaimer:
        cleanText(
          theory.default_disclaimer
        ) ||
        '以上為可能性分析，並非案件定論'
    },


    ending_card: {

      enabled:
        safeBoolean(
          ending.enabled,
          true
        ),

      duration:
        Math.max(
          1,
          Math.min(
            8,
            safeNumber(
              ending.duration,
              3
            )
          )
        ),

      title:
        cleanText(
          ending.title
        ) ||
        cleanText(
          project.ending_title
        ) ||
        '異常夜話 Midnight Files',

      subtitle:
        cleanText(
          ending.subtitle
        ) ||
        cleanText(
          project.ending_subtitle
        ) ||
        '',

      footer:
        cleanText(
          ending.footer
        ) ||
        cleanText(
          project.ending_footer
        ) ||
        '案件資料與情境重建內容請以本集來源說明為準'
    }
  };
}


// ============================================================
// PAYLOAD VALIDATION
// ============================================================

function validateScenes(
  scenes
) {

  if (!Array.isArray(scenes) || scenes.length < EXPECTED_SHOTS_PER_SCENE) {
    throw new Error('scenes must contain visual items');
  }

  if (scenes.length % EXPECTED_SHOTS_PER_SCENE !== 0) {
    throw new Error(
      `Visual count ${scenes.length} is not divisible by ${EXPECTED_SHOTS_PER_SCENE} shots per scene`
    );
  }

  const expectedScenes = scenes.length / EXPECTED_SHOTS_PER_SCENE;

  if (
    !Number.isInteger(expectedScenes) ||
    expectedScenes < MIN_SCENES ||
    expectedScenes > MAX_SCENES
  ) {
    throw new Error(
      `Scene count must be ${MIN_SCENES}-${MAX_SCENES}; received ${expectedScenes}`
    );
  }

  const keySet = new Set();
  const renderIndexSet = new Set();

  for (const visual of scenes) {
    const sceneNumber = safeNumber(visual.scene_number, null);
    const shotIndex = safeNumber(
      visual.shot_index ?? visual.shot_number,
      null
    );
    const renderIndex = safeNumber(visual.render_index, null);

    if (
      !Number.isInteger(sceneNumber) ||
      sceneNumber < 1 ||
      sceneNumber > expectedScenes
    ) {
      throw new Error(`Invalid scene_number: ${sceneNumber}`);
    }

    if (
      !Number.isInteger(shotIndex) ||
      shotIndex < 1 ||
      shotIndex > EXPECTED_SHOTS_PER_SCENE
    ) {
      throw new Error(
        `Invalid shot_index at Scene ${sceneNumber}: ${shotIndex}`
      );
    }

    const key = `${sceneNumber}-${shotIndex}`;
    if (keySet.has(key)) {
      throw new Error(
        `Duplicate visual: Scene ${sceneNumber} Shot ${shotIndex}`
      );
    }
    keySet.add(key);

    if (
      !Number.isInteger(renderIndex) ||
      renderIndex < 1 ||
      renderIndex > scenes.length
    ) {
      throw new Error(`Invalid render_index: ${renderIndex}`);
    }

    if (renderIndexSet.has(renderIndex)) {
      throw new Error(`Duplicate render_index: ${renderIndex}`);
    }
    renderIndexSet.add(renderIndex);

    if (!cleanText(visual.image_url)) {
      throw new Error(
        `Scene ${sceneNumber} Shot ${shotIndex} missing image_url`
      );
    }
  }

  for (let sceneNumber = 1; sceneNumber <= expectedScenes; sceneNumber++) {
    for (
      let shotIndex = 1;
      shotIndex <= EXPECTED_SHOTS_PER_SCENE;
      shotIndex++
    ) {
      if (!keySet.has(`${sceneNumber}-${shotIndex}`)) {
        throw new Error(
          `Missing Scene ${sceneNumber} Shot ${shotIndex}`
        );
      }
    }
  }

  for (let index = 1; index <= scenes.length; index++) {
    if (!renderIndexSet.has(index)) {
      throw new Error(`Missing render_index ${index}`);
    }
  }

  return {
    expectedScenes,
    expectedVisuals: scenes.length
  };
}


function validateAudioParts(
  audioParts
) {

  if (
    audioParts.length <
      MIN_AUDIO_PARTS ||
    audioParts.length >
      MAX_AUDIO_PARTS
  ) {

    throw new Error(
      `audio_parts must contain ${MIN_AUDIO_PARTS}-${MAX_AUDIO_PARTS} items; received ${audioParts.length}`
    );
  }

  const indexSet =
    new Set();

  const fileIdSet =
    new Set();

  const urlSet =
    new Set();

  for (
    const part of
    audioParts
  ) {

    const partIndex =
      safeNumber(
        part.part_index,
        null
      );

    if (
      !Number.isInteger(
        partIndex
      ) ||
      partIndex < 1 ||
      partIndex >
        audioParts.length
    ) {

      throw new Error(
        `Invalid audio part_index: ${partIndex}`
      );
    }

    if (
      indexSet.has(
        partIndex
      )
    ) {

      throw new Error(
        `Duplicate audio part_index: ${partIndex}`
      );
    }

    indexSet.add(
      partIndex
    );

    const audioUrl =
      cleanText(
        part.audio_url
      );

    if (!audioUrl) {

      throw new Error(
        `Audio Part ${partIndex} missing audio_url`
      );
    }

    if (
      urlSet.has(
        audioUrl
      )
    ) {

      throw new Error(
        `Duplicate audio_url at Part ${partIndex}`
      );
    }

    urlSet.add(
      audioUrl
    );

    const fileId =
      cleanText(
        part.audio_file_id ??
        part.file_id
      );

    if (!fileId) {

      throw new Error(
        `Audio Part ${partIndex} missing audio_file_id`
      );
    }

    if (
      [
        'anyone',
        'anyonewithlink',
        'reader',
        'writer'
      ].includes(
        fileId.toLowerCase()
      )
    ) {

      throw new Error(
        `Audio Part ${partIndex} contains permission ID instead of Drive file ID`
      );
    }

    if (
      fileIdSet.has(
        fileId
      )
    ) {

      throw new Error(
        `Duplicate audio_file_id at Part ${partIndex}`
      );
    }

    fileIdSet.add(
      fileId
    );
  }

  for (
    let index = 1;
    index <=
    audioParts.length;
    index++
  ) {

    if (
      !indexSet.has(
        index
      )
    ) {

      throw new Error(
        `Missing Audio Part ${index}`
      );
    }
  }
}


// ============================================================
// SCENE TIMING VALIDATION
// ============================================================

function normalizeSceneTimings({
  input,
  scenes
}) {

  const supplied =
    safeArray(
      input
    );

  const expectedScenes = Math.max(
    1,
    ...scenes.map(visual => safeNumber(visual.scene_number, 0))
  );

  const fallbackMap =
    new Map();

  for (
    const visual of
    scenes
  ) {

    const sceneNumber =
      safeNumber(
        visual.scene_number,
        null
      );

    if (
      !Number.isInteger(
        sceneNumber
      )
    ) {
      continue;
    }

    if (
      !fallbackMap.has(
        sceneNumber
      )
    ) {

      fallbackMap.set(
        sceneNumber,
        Math.max(
          1,
          safeNumber(
            visual.narration_chars,
            cleanText(
              visual.narration
            ).length ||
            1
          )
        )
      );
    }
  }

  let normalized = [];

  if (
    supplied.length ===
    expectedScenes
  ) {

    normalized =
      supplied.map(
        item => ({

          scene_number:
            safeNumber(
              item.scene_number,
              null
            ),

          narration_chars:
            Math.max(
              1,
              safeNumber(
                item.narration_chars,
                1
              )
            ),

          supplied_weight:
            safeNumber(
              item.narration_weight,
              null
            )
        })
      );

  } else {

    normalized =
      Array.from(
        {
          length:
            expectedScenes
        },
        (
          _,
          index
        ) => {

          const sceneNumber =
            index + 1;

          return {

            scene_number:
              sceneNumber,

            narration_chars:
              Math.max(
                1,
                fallbackMap.get(
                  sceneNumber
                ) ||
                1
              ),

            supplied_weight:
              null
          };
        }
      );
  }

  normalized.sort(
    (a, b) =>
      a.scene_number -
      b.scene_number
  );

  const seen =
    new Set();

  for (
    let index = 0;
    index <
      normalized.length;
    index++
  ) {

    const item =
      normalized[index];

    const expected =
      index + 1;

    if (
      !Number.isInteger(
        item.scene_number
      ) ||
      item.scene_number !==
        expected
    ) {

      throw new Error(
        `scene_timings must contain Scene 1-${expectedScenes}; expected ${expected}, received ${item.scene_number}`
      );
    }

    if (
      seen.has(
        item.scene_number
      )
    ) {

      throw new Error(
        `Duplicate scene_timing for Scene ${item.scene_number}`
      );
    }

    seen.add(
      item.scene_number
    );
  }

  const charTotal =
    normalized.reduce(
      (
        sum,
        item
      ) =>
        sum +
        item.narration_chars,
      0
    );

  if (
    !Number.isFinite(
      charTotal
    ) ||
    charTotal <= 0
  ) {

    throw new Error(
      'Invalid total narration chars in scene_timings'
    );
  }

  return normalized.map(
    item => ({

      scene_number:
        item.scene_number,

      narration_chars:
        item.narration_chars,

      narration_weight:
        item.narration_chars /
        charTotal
    })
  );
}


// ============================================================
// BUILD SCENE TIMELINE
// ============================================================

function buildSceneTimeline({
  scenes,
  sceneTimings,
  narrationDuration
}) {

  if (
    !Number.isFinite(
      narrationDuration
    ) ||
    narrationDuration <= 0
  ) {

    throw new Error(
      'Invalid narrationDuration'
    );
  }

  const visualMap =
    new Map();

  for (
    const visual of
    scenes
  ) {

    const sceneNumber =
      safeNumber(
        visual.scene_number,
        null
      );

    if (
      !visualMap.has(
        sceneNumber
      )
    ) {

      visualMap.set(
        sceneNumber,
        []
      );
    }

    visualMap
      .get(
        sceneNumber
      )
      .push(
        visual
      );
  }

  const timeline = [];

  let allocated =
    0;

  for (
    let index = 0;
    index <
      sceneTimings.length;
    index++
  ) {

    const timing =
      sceneTimings[index];

    const sceneNumber =
      timing.scene_number;

    const visuals =
      visualMap.get(
        sceneNumber
      ) ||
      [];

    if (
      visuals.length !==
      EXPECTED_SHOTS_PER_SCENE
    ) {

      throw new Error(
        `Scene ${sceneNumber} must contain exactly ${EXPECTED_SHOTS_PER_SCENE} visuals`
      );
    }

    let sceneDuration;

    if (
      index ===
      sceneTimings.length - 1
    ) {

      sceneDuration =
        narrationDuration -
        allocated;

    } else {

      sceneDuration =
        narrationDuration *
        timing.narration_weight;

      allocated +=
        sceneDuration;
    }

    if (
      !Number.isFinite(
        sceneDuration
      ) ||
      sceneDuration <= 0
    ) {

      throw new Error(
        `Invalid duration generated for Scene ${sceneNumber}`
      );
    }

    const shotDuration =
      sceneDuration /
      EXPECTED_SHOTS_PER_SCENE;

    if (
      !Number.isFinite(
        shotDuration
      ) ||
      shotDuration <= 0
    ) {

      throw new Error(
        `Invalid shot duration generated for Scene ${sceneNumber}`
      );
    }

    timeline.push({

      scene_number:
        sceneNumber,

      narration_chars:
        timing.narration_chars,

      narration_weight:
        timing.narration_weight,

      duration:
        sceneDuration,

      shot_count:
        EXPECTED_SHOTS_PER_SCENE,

      shot_duration:
        shotDuration
    });
  }

  const total =
    timeline.reduce(
      (
        sum,
        item
      ) =>
        sum +
        item.duration,
      0
    );

  const difference =
    narrationDuration -
    total;

  if (
    Math.abs(
      difference
    ) >
    0.000001
  ) {

    const last =
      timeline[
        timeline.length - 1
      ];

    last.duration +=
      difference;

    last.shot_duration =
      last.duration /
      EXPECTED_SHOTS_PER_SCENE;
  }

  const finalTotal =
    timeline.reduce(
      (
        sum,
        item
      ) =>
        sum +
        item.duration,
      0
    );

  if (
    Math.abs(
      finalTotal -
      narrationDuration
    ) >
    0.01
  ) {

    throw new Error(
      `Scene timeline duration mismatch. narration=${narrationDuration.toFixed(3)} timeline=${finalTotal.toFixed(3)}`
    );
  }

  return timeline;
}


// ============================================================
// SILENCE
// ============================================================

async function createSilence({
  jobId,
  destination,
  duration,
  settings
}) {

  if (
    duration <= 0
  ) {
    return;
  }

  await runProcess(
    jobId,
    'ffmpeg',
    [
      '-y',

      '-f',
      'lavfi',

      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',

      '-t',
      String(
        duration
      ),

      '-c:a',
      'aac',

      '-b:a',
      settings.audio_bitrate,

      '-ar',
      '48000',

      '-ac',
      '2',

      destination
    ]
  );
}


// ============================================================
// OPENING CARD
// ============================================================

async function createOpeningCard({
  jobId,
  destination,
  settings,
  presentation,
  fontFile
}) {

  const {
    width,
    height,
    fps,
    preset,
    crf,
    threads
  } =
    settings;

  const opening =
    presentation
      .opening_disclaimer;

  const filters = [

    drawTextFilter({
      text:
        opening.line_1,

      fontFile,

      fontSize:
        Math.round(
          height *
          0.047
        ),

      x:
        '(w-text_w)/2',

      y:
        '(h/2)-55',

      box:
        false
    }),

    drawTextFilter({
      text:
        opening.line_2,

      fontFile,

      fontSize:
        Math.round(
          height *
          0.033
        ),

      x:
        '(w-text_w)/2',

      y:
        '(h/2)+20',

      fontColor:
        'white@0.82',

      box:
        false
    })
  ];

  await runProcess(
    jobId,
    'ffmpeg',
    [
      '-y',

      '-f',
      'lavfi',

      '-i',
      `color=c=black:s=${width}x${height}:r=${fps}:d=${opening.duration}`,

      '-vf',
      filters
        .filter(Boolean)
        .join(','),

      '-an',

      '-c:v',
      'libx264',

      '-preset',
      preset,

      '-crf',
      String(crf),

      '-threads',
      String(threads),

      '-pix_fmt',
      'yuv420p',

      '-movflags',
      '+faststart',

      destination
    ]
  );
}


// ============================================================
// ENDING CARD
// ============================================================

async function createEndingCard({
  jobId,
  destination,
  settings,
  presentation,
  fontFile
}) {

  const {
    width,
    height,
    fps,
    preset,
    crf,
    threads
  } =
    settings;

  const ending =
    presentation
      .ending_card;

  const filters = [

    drawTextFilter({
      text:
        ending.title,

      fontFile,

      fontSize:
        Math.round(
          height *
          0.075
        ),

      x:
        '(w-text_w)/2',

      y:
        '(h/2)-100',

      box:
        false
    }),

    drawTextFilter({
      text:
        ending.subtitle,

      fontFile,

      fontSize:
        Math.round(
          height *
          0.045
        ),

      x:
        '(w-text_w)/2',

      y:
        '(h/2)-10',

      fontColor:
        'white@0.82',

      box:
        false
    }),

    drawTextFilter({
      text:
        ending.footer,

      fontFile,

      fontSize:
        Math.round(
          height *
          0.031
        ),

      x:
        '(w-text_w)/2',

      y:
        '(h/2)+80',

      fontColor:
        'white@0.72',

      box:
        false
    })
  ];

  await runProcess(
    jobId,
    'ffmpeg',
    [
      '-y',

      '-f',
      'lavfi',

      '-i',
      `color=c=black:s=${width}x${height}:r=${fps}:d=${ending.duration}`,

      '-vf',
      filters
        .filter(Boolean)
        .join(','),

      '-an',

      '-c:v',
      'libx264',

      '-preset',
      preset,

      '-crf',
      String(crf),

      '-threads',
      String(threads),

      '-pix_fmt',
      'yuv420p',

      '-movflags',
      '+faststart',

      destination
    ]
  );
}


// ============================================================
// VISUAL SEGMENT
// ============================================================

async function createVisualSegment({
  jobId,
  imagePath,
  destination,
  duration,
  visual,
  settings,
  presentationSettings,
  fontFile
}) {

  const {
    width,
    height,
    fps,
    preset,
    crf,
    threads
  } =
    settings;

  if (
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {

    throw new Error(
      `Invalid visual duration: ${duration}`
    );
  }

  const p =
    safeObject(
      visual.presentation
    );

  const filters = [];

  filters.push(
    `scale=${width}:${height}:force_original_aspect_ratio=increase`
  );

  filters.push(
    `crop=${width}:${height}`
  );

  const totalFrames =
    Math.max(
      1,
      Math.round(
        duration *
        fps
      )
    );

  filters.push(
    `zoompan=z='min(zoom+0.00008,1.035)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`
  );


  // ----------------------------------------------------------
  // AI RECONSTRUCTION
  // ----------------------------------------------------------

  if (
    presentationSettings
      .reconstruction_overlay
      .enabled &&
    p.reconstruction !==
      false
  ) {

    const label =
      cleanText(
        p.reconstruction_label
      ) ||
      cleanText(
        visual.reconstruction_label
      ) ||
      presentationSettings
        .reconstruction_overlay
        .text;

    filters.push(
      drawTextFilter({
        text:
          label,

        fontFile,

        fontSize:
          Math.round(
            height *
            0.026
          ),

        x:
          'w-text_w-24',

        y:
          '22',

        fontColor:
          'white@0.78',

        boxColor:
          'black@0.38',

        boxBorder:
          10
      })
    );
  }


  // ----------------------------------------------------------
  // DATE / LOCATION
  // ----------------------------------------------------------

  if (
    presentationSettings
      .info_card
      .enabled
  ) {

    const date =
      presentationSettings
        .info_card
        .show_date
        ? (
            cleanText(
              p.date_card
            ) ||
            cleanText(
              visual.date_card
            )
          )
        : '';

    const location =
      presentationSettings
        .info_card
        .show_location
        ? (
            cleanText(
              p.location_card
            ) ||
            cleanText(
              visual.location_card
            )
          )
        : '';

    const maxDuration =
      Math.min(
        duration,
        presentationSettings
          .info_card
          .max_duration
      );

    const enable =
      `between(t,0,${roundDuration(maxDuration)})`;

    if (date) {

      filters.push(
        drawTextFilter({
          text:
            date,

          fontFile,

          fontSize:
            Math.round(
              height *
              0.041
            ),

          x:
            '28',

          y:
            'h-112',

          boxColor:
            'black@0.52',

          boxBorder:
            12,

          enable
        })
      );
    }

    if (location) {

      filters.push(
        drawTextFilter({
          text:
            location,

          fontFile,

          fontSize:
            Math.round(
              height *
              0.028
            ),

          x:
            '28',

          y:
            'h-60',

          fontColor:
            'white@0.84',

          boxColor:
            'black@0.46',

          boxBorder:
            10,

          enable
        })
      );
    }
  }


  // ----------------------------------------------------------
  // THEORY
  // ----------------------------------------------------------

  const sceneType =
    cleanText(
      p.scene_type
    ) ||
    cleanText(
      visual.scene_type
    );

  const theoryLabel =
    cleanText(
      p.theory_label
    ) ||
    cleanText(
      visual.theory_label
    );

  if (
    presentationSettings
      .theory_overlay
      .enabled &&
    (
      sceneType ===
        'theory' ||
      theoryLabel
    )
  ) {

    const theoryTitle =
      theoryLabel ||
      presentationSettings
        .theory_overlay
        .default_title;

    const theoryDisclaimer =
      cleanText(
        p.disclaimer
      ) ||
      cleanText(
        visual.disclaimer
      ) ||
      presentationSettings
        .theory_overlay
        .default_disclaimer;

    filters.push(
      drawTextFilter({
        text:
          theoryTitle,

        fontFile,

        fontSize:
          Math.round(
            height *
            0.035
          ),

        x:
          '28',

        y:
          '28',

        boxColor:
          'black@0.50',

        boxBorder:
          11
      })
    );

    filters.push(
      drawTextFilter({
        text:
          theoryDisclaimer,

        fontFile,

        fontSize:
          Math.round(
            height *
            0.026
          ),

        x:
          '(w-text_w)/2',

        y:
          'h-38',

        fontColor:
          'white@0.82',

        boxColor:
          'black@0.55',

        boxBorder:
          10
      })
    );
  }


  await runProcess(
    jobId,
    'ffmpeg',
    [
      '-y',

      '-loop',
      '1',

      '-i',
      imagePath,

      '-t',
      String(
        roundDuration(
          duration
        )
      ),

      '-vf',
      filters
        .filter(Boolean)
        .join(','),

      '-an',

      '-r',
      String(fps),

      '-c:v',
      'libx264',

      '-preset',
      preset,

      '-crf',
      String(crf),

      '-threads',
      String(threads),

      '-pix_fmt',
      'yuv420p',

      '-movflags',
      '+faststart',

      destination
    ]
  );
}


// ============================================================
// CONCAT VIDEO
// ============================================================

async function concatVideoSegments({
  jobId,
  files,
  destination,
  workDir,
  settings
}) {

  const concatFile =
    path.join(
      workDir,
      'video_concat.txt'
    );

  const content =
    files
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join('\n');

  await fsp.writeFile(
    concatFile,
    content,
    'utf8'
  );

  try {

    await runProcess(
      jobId,
      'ffmpeg',
      [
        '-y',

        '-f',
        'concat',

        '-safe',
        '0',

        '-i',
        concatFile,

        '-c',
        'copy',

        destination
      ]
    );

    return;

  } catch (error) {

    assertJobActive(
      jobId
    );

    console.warn(
      `[${jobId}] Stream-copy concat failed; falling back to re-encode`
    );
  }

  await runProcess(
    jobId,
    'ffmpeg',
    [
      '-y',

      '-f',
      'concat',

      '-safe',
      '0',

      '-i',
      concatFile,

      '-c:v',
      'libx264',

      '-preset',
      settings.preset,

      '-crf',
      String(
        settings.crf
      ),

      '-threads',
      String(
        settings.threads
      ),

      '-pix_fmt',
      'yuv420p',

      '-an',

      '-movflags',
      '+faststart',

      destination
    ]
  );
}


// ============================================================
// CONCAT AUDIO
// ============================================================

async function concatAudio({
  jobId,
  files,
  destination,
  workDir,
  settings
}) {

  if (
    !files.length
  ) {

    throw new Error(
      'concatAudio received no files'
    );
  }

  const concatFile =
    path.join(
      workDir,
      `audio_concat_${crypto.randomUUID()}.txt`
    );

  const content =
    files
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join('\n');

  await fsp.writeFile(
    concatFile,
    content,
    'utf8'
  );

  try {

    await runProcess(
      jobId,
      'ffmpeg',
      [
        '-y',

        '-f',
        'concat',

        '-safe',
        '0',

        '-i',
        concatFile,

        '-ar',
        '48000',

        '-ac',
        '2',

        '-c:a',
        'aac',

        '-b:a',
        settings.audio_bitrate,

        destination
      ]
    );

  } finally {

    try {

      await fsp.rm(
        concatFile,
        {
          force: true
        }
      );

    } catch (_) {}
  }
}


// ============================================================
// FINAL AUDIO
// ============================================================

async function buildFinalAudioTimeline({
  jobId,
  narrationPath,
  openingDuration,
  endingDuration,
  destination,
  workDir,
  settings
}) {

  const parts = [];

  if (
    openingDuration > 0
  ) {

    const openingSilence =
      path.join(
        workDir,
        'opening_silence.m4a'
      );

    await createSilence({
      jobId,

      destination:
        openingSilence,

      duration:
        openingDuration,

      settings
    });

    parts.push(
      openingSilence
    );
  }

  parts.push(
    narrationPath
  );

  if (
    endingDuration > 0
  ) {

    const endingSilence =
      path.join(
        workDir,
        'ending_silence.m4a'
      );

    await createSilence({
      jobId,

      destination:
        endingSilence,

      duration:
        endingDuration,

      settings
    });

    parts.push(
      endingSilence
    );
  }

  await concatAudio({
    jobId,

    files:
      parts,

    destination,

    workDir,

    settings
  });
}


// ============================================================
// FINAL MUX
// ============================================================

async function muxFinal({
  jobId,
  videoPath,
  audioPath,
  destination,
  settings
}) {

  // Do NOT use -shortest.
  // Durations are validated before muxing.
  await runProcess(
    jobId,
    'ffmpeg',
    [
      '-y',

      '-i',
      videoPath,

      '-i',
      audioPath,

      '-map',
      '0:v:0',

      '-map',
      '1:a:0',

      '-c:v',
      'copy',

      '-c:a',
      'aac',

      '-b:a',
      settings.audio_bitrate,

      '-pix_fmt',
      'yuv420p',

      '-movflags',
      '+faststart',

      destination
    ]
  );
}


// ============================================================
// MAIN RENDER
// ============================================================

async function processRender(
  jobId,
  payload
) {

  const workDir =
    path.join(
      JOBS_DIR,
      jobId
    );

  const imageDir =
    path.join(
      workDir,
      'images'
    );

  const audioDir =
    path.join(
      workDir,
      'audio'
    );

  const segmentDir =
    path.join(
      workDir,
      'segments'
    );

  try {

    assertJobActive(
      jobId
    );

    updateJob(
      jobId,
      {
        status:
          'processing',

        started_at:
          nowIso(),

        progress:
          1,

        current_step:
          'initializing'
      }
    );

    await Promise.all([

      fsp.mkdir(
        imageDir,
        {
          recursive: true
        }
      ),

      fsp.mkdir(
        audioDir,
        {
          recursive: true
        }
      ),

      fsp.mkdir(
        segmentDir,
        {
          recursive: true
        }
      )
    ]);

    assertJobActive(
      jobId
    );


    // --------------------------------------------------------
    // INPUT
    // --------------------------------------------------------

    const scenes =
      safeArray(
        payload.scenes
      )
        .slice()
        .map(
          visual => ({

            ...visual,

            shot_index:
              safeNumber(
                visual.shot_index ??
                visual.shot_number,
                null
              )
          })
        )
        .sort(
          (
            a,
            b
          ) =>
            safeNumber(
              a.render_index,
              0
            ) -
            safeNumber(
              b.render_index,
              0
            )
        );


    const audioParts =
      safeArray(
        payload.audio_parts
      )
        .slice()
        .sort(
          (
            a,
            b
          ) =>
            safeNumber(
              a.part_index,
              0
            ) -
            safeNumber(
              b.part_index,
              0
            )
        );


    validateScenes(
      scenes
    );

    validateAudioParts(
      audioParts
    );


    const settings =
      normalizeRenderSettings(
        payload.render_settings
      );


    const project =
      safeObject(
        payload.project
      );


    const presentation =
      normalizePresentation(
        payload.presentation_settings,
        project
      );


    const sceneTimings =
      normalizeSceneTimings({
        input:
          payload.scene_timings,

        scenes
      });


    const openingDuration =
      presentation
        .opening_disclaimer
        .enabled
        ? presentation
            .opening_disclaimer
            .duration
        : 0;


    const endingDuration =
      presentation
        .ending_card
        .enabled
        ? presentation
            .ending_card
            .duration
        : 0;


    updateJob(
      jobId,
      {
        total_visuals:
          scenes.length,

        total_audio_parts:
          audioParts.length,

        opening_duration:
          openingDuration,

        ending_duration:
          endingDuration
      }
    );


    // --------------------------------------------------------
    // FONT
    // --------------------------------------------------------

    updateJob(
      jobId,
      {
        progress:
          2,

        current_step:
          'checking_font'
      }
    );


    const fontFile =
      await detectFont();


    if (!fontFile) {

      throw new Error(
        'No usable font found. Install Noto Sans CJK or set CJK_FONT_PATH.'
      );
    }


    // --------------------------------------------------------
    // IMAGES
    // --------------------------------------------------------

    const imagePaths =
      [];


    for (
      let index = 0;
      index <
        scenes.length;
      index++
    ) {

      assertJobActive(
        jobId
      );

      const visual =
        scenes[index] ??
        {};


      const sceneNumber =
        safeNumber(
          visual.scene_number,
          null
        );


      const shotIndex =
        safeNumber(
          visual.shot_index,
          null
        );


      const imageUrl =
        cleanText(
          visual.image_url
        );


      updateJob(
        jobId,
        {
          progress:
            Math.min(
              18,
              3 +
              Math.floor(
                (
                  index /
                  scenes.length
                ) *
                15
              )
            ),

          current_step:
            `downloading_image_${index + 1}_of_${scenes.length}`
        }
      );


      const destination =
        path.join(
          imageDir,
          `visual_${String(index + 1).padStart(3, '0')}.img`
        );


      await downloadFile({
        jobId,

        url:
          imageUrl,

        destination,

        type:
          'image',

        sceneNumber,

        shotIndex
      });


      imagePaths.push(
        destination
      );
    }


    // --------------------------------------------------------
    // AUDIO DOWNLOAD
    // --------------------------------------------------------

    const audioPaths =
      [];

    const audioPartDurations =
      [];


    for (
      let index = 0;
      index <
        audioParts.length;
      index++
    ) {

      assertJobActive(
        jobId
      );


      const part =
        audioParts[index] ??
        {};


      const partIndex =
        safeNumber(
          part.part_index,
          index + 1
        );


      const audioUrl =
        cleanText(
          part.audio_url
        );


      updateJob(
        jobId,
        {
          progress:
            Math.min(
              24,
              19 +
              Math.floor(
                (
                  index /
                  audioParts.length
                ) *
                5
              )
            ),

          current_step:
            `downloading_audio_${index + 1}_of_${audioParts.length}`
        }
      );


      const destination =
        path.join(
          audioDir,
          `audio_${String(partIndex).padStart(3, '0')}.mp3`
        );


      await downloadFile({
        jobId,

        url:
          audioUrl,

        destination,

        type:
          'audio',

        partIndex
      });


      const duration =
        await getMediaDuration(
          jobId,
          destination
        );


      audioPaths.push(
        destination
      );


      audioPartDurations.push({

        part_index:
          partIndex,

        duration:
          Number(
            duration.toFixed(3)
          )
      });
    }


    updateJob(
      jobId,
      {
        audio_part_durations:
          audioPartDurations
      }
    );


    // --------------------------------------------------------
    // CONCAT NARRATION
    // --------------------------------------------------------

    assertJobActive(
      jobId
    );


    updateJob(
      jobId,
      {
        progress:
          25,

        current_step:
          'concatenating_narration'
      }
    );


    const narrationAudio =
      path.join(
        workDir,
        'narration_audio.m4a'
      );


    await concatAudio({
      jobId,

      files:
        audioPaths,

      destination:
        narrationAudio,

      workDir,

      settings
    });


    const narrationDuration =
      await getMediaDuration(
        jobId,
        narrationAudio
      );


    updateJob(
      jobId,
      {
        narration_duration:
          Number(
            narrationDuration
              .toFixed(3)
          )
      }
    );


    // --------------------------------------------------------
    // BUILD SCENE TIMELINE
    // --------------------------------------------------------

    assertJobActive(
      jobId
    );


    updateJob(
      jobId,
      {
        progress:
          26,

        current_step:
          'building_scene_timeline'
      }
    );


    const sceneTimeline =
      buildSceneTimeline({
        scenes,

        sceneTimings,

        narrationDuration
      });


    const sceneTimelineTotal =
      sceneTimeline.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.duration,
        0
      );


    const timelineDifference =
      Math.abs(
        sceneTimelineTotal -
        narrationDuration
      );


    if (
      timelineDifference >
      0.01
    ) {

      throw new Error(
        `Timeline QA failed: narration=${narrationDuration.toFixed(3)} scenes=${sceneTimelineTotal.toFixed(3)} difference=${timelineDifference.toFixed(3)}`
      );
    }


    updateJob(
      jobId,
      {
        scene_timeline:
          sceneTimeline.map(
            item => ({

              scene_number:
                item.scene_number,

              narration_chars:
                item.narration_chars,

              narration_weight:
                Number(
                  item
                    .narration_weight
                    .toFixed(8)
                ),

              duration:
                Number(
                  item
                    .duration
                    .toFixed(3)
                ),

              shot_count:
                item.shot_count,

              shot_duration:
                Number(
                  item
                    .shot_duration
                    .toFixed(3)
                )
            })
          ),

        timeline_validation: {

          passed:
            true,

          narration_duration:
            Number(
              narrationDuration
                .toFixed(3)
            ),

          scene_duration_total:
            Number(
              sceneTimelineTotal
                .toFixed(3)
            ),

          difference_seconds:
            Number(
              timelineDifference
                .toFixed(6)
            )
        }
      }
    );


    // --------------------------------------------------------
    // FINAL AUDIO
    // --------------------------------------------------------

    assertJobActive(
      jobId
    );


    updateJob(
      jobId,
      {
        progress:
          27,

        current_step:
          'building_audio_timeline'
      }
    );


    const finalAudio =
      path.join(
        workDir,
        'final_audio.m4a'
      );


    await buildFinalAudioTimeline({
      jobId,

      narrationPath:
        narrationAudio,

      openingDuration,

      endingDuration,

      destination:
        finalAudio,

      workDir,

      settings
    });


    const finalAudioDuration =
      await getMediaDuration(
        jobId,
        finalAudio
      );


    updateJob(
      jobId,
      {
        final_audio_duration:
          Number(
            finalAudioDuration
              .toFixed(3)
          )
      }
    );


    // --------------------------------------------------------
    // EXPECTED FINAL DURATION
    // --------------------------------------------------------

    const expectedFinalDuration =
      openingDuration +
      narrationDuration +
      endingDuration;


    const audioTimelineDifference =
      Math.abs(
        finalAudioDuration -
        expectedFinalDuration
      );


    if (
      audioTimelineDifference >
      MEDIA_DURATION_TOLERANCE_SECONDS
    ) {

      throw new Error(
        `Final audio timeline mismatch. expected=${expectedFinalDuration.toFixed(3)} actual=${finalAudioDuration.toFixed(3)}`
      );
    }


    const videoSegments =
      [];


    // --------------------------------------------------------
    // OPENING
    // --------------------------------------------------------

    if (
      presentation
        .opening_disclaimer
        .enabled
    ) {

      assertJobActive(
        jobId
      );


      updateJob(
        jobId,
        {
          progress:
            29,

          current_step:
            'rendering_opening_disclaimer'
        }
      );


      const openingPath =
        path.join(
          segmentDir,
          'segment_000_opening.mp4'
        );


      await createOpeningCard({
        jobId,

        destination:
          openingPath,

        settings,

        presentation,

        fontFile
      });


      videoSegments.push(
        openingPath
      );
    }


    // --------------------------------------------------------
    // VISUALS
    // --------------------------------------------------------

    const renderedShotsPerScene =
      new Map();

    const renderedSegmentPaths =
      new Array(scenes.length);

    let nextVisualIndex = 0;
    let completedVisuals = 0;

    async function renderVisualWorker() {
      while (true) {
        assertJobActive(jobId);

        const index = nextVisualIndex++;
        if (index >= scenes.length) {
          return;
        }

        const visual = scenes[index] ?? {};
        const sceneNumber = safeNumber(visual.scene_number, null);
        const shotIndex = safeNumber(visual.shot_index, null);
        const timeline = sceneTimeline.find(
          item => item.scene_number === sceneNumber
        );

        if (!timeline) {
          const error = new Error(
            `No timeline found for Scene ${sceneNumber}`
          );
          error.sceneNumber = sceneNumber;
          error.shotIndex = shotIndex;
          throw error;
        }

        // Duration is deterministic from shot index; no shared mutable
        // counter is needed, so workers can render safely in parallel.
        let duration = timeline.shot_duration;
        if (shotIndex === EXPECTED_SHOTS_PER_SCENE) {
          duration = timeline.duration -
            timeline.shot_duration *
            (EXPECTED_SHOTS_PER_SCENE - 1);
        }

        if (!Number.isFinite(duration) || duration <= 0) {
          const error = new Error(
            `Invalid duration for Scene ${sceneNumber} Shot ${shotIndex}: ${duration}`
          );
          error.sceneNumber = sceneNumber;
          error.shotIndex = shotIndex;
          throw error;
        }

        const segmentPath = path.join(
          segmentDir,
          `segment_${String(index + 1).padStart(3, '0')}.mp4`
        );

        await createVisualSegment({
          jobId,
          imagePath: imagePaths[index],
          destination: segmentPath,
          duration,
          visual,
          settings,
          presentationSettings: presentation,
          fontFile
        });

        renderedSegmentPaths[index] = segmentPath;
        renderedShotsPerScene.set(
          sceneNumber,
          (renderedShotsPerScene.get(sceneNumber) || 0) + 1
        );

        completedVisuals++;
        updateJob(jobId, {
          progress: Math.min(
            82,
            30 + Math.floor((completedVisuals / scenes.length) * 52)
          ),
          current_step:
            `rendering_visuals_${completedVisuals}_of_${scenes.length}`
        });
      }
    }

    const workerCount = Math.min(
      VISUAL_RENDER_CONCURRENCY,
      scenes.length
    );

    await Promise.all(
      Array.from(
        { length: workerCount },
        () => renderVisualWorker()
      )
    );

    for (let sceneNumber = 1; sceneNumber <= sceneTimeline.length; sceneNumber++) {
      if (
        renderedShotsPerScene.get(sceneNumber) !==
        EXPECTED_SHOTS_PER_SCENE
      ) {
        throw new Error(
          `Scene ${sceneNumber} rendered shot count mismatch`
        );
      }
    }

    videoSegments.push(...renderedSegmentPaths);


    // --------------------------------------------------------
    // ENDING
    // --------------------------------------------------------

    if (
      presentation
        .ending_card
        .enabled
    ) {

      assertJobActive(
        jobId
      );


      updateJob(
        jobId,
        {
          progress:
            84,

          current_step:
            'rendering_ending_card'
        }
      );


      const endingPath =
        path.join(
          segmentDir,
          'segment_999_ending.mp4'
        );


      await createEndingCard({
        jobId,

        destination:
          endingPath,

        settings,

        presentation,

        fontFile
      });


      videoSegments.push(
        endingPath
      );
    }


    // --------------------------------------------------------
    // CONCAT VIDEO
    // --------------------------------------------------------

    assertJobActive(
      jobId
    );


    updateJob(
      jobId,
      {
        progress:
          87,

        current_step:
          'concatenating_video'
      }
    );


    const combinedVideo =
      path.join(
        workDir,
        'combined_video.mp4'
      );


    await concatVideoSegments({
      jobId,

      files:
        videoSegments,

      destination:
        combinedVideo,

      workDir,

      settings
    });


    const combinedVideoDuration =
      await getMediaDuration(
        jobId,
        combinedVideo
      );


    updateJob(
      jobId,
      {
        combined_video_duration:
          Number(
            combinedVideoDuration
              .toFixed(3)
          )
      }
    );


    // --------------------------------------------------------
    // VIDEO TIMELINE QA
    // --------------------------------------------------------

    const videoTimelineDifference =
      Math.abs(
        combinedVideoDuration -
        expectedFinalDuration
      );


    if (
      videoTimelineDifference >
      MEDIA_DURATION_TOLERANCE_SECONDS
    ) {

      throw new Error(
        [
          'Combined video duration mismatch',
          `expected=${expectedFinalDuration.toFixed(3)}`,
          `actual=${combinedVideoDuration.toFixed(3)}`,
          `difference=${videoTimelineDifference.toFixed(3)}`
        ].join(' | ')
      );
    }


    // --------------------------------------------------------
    // FINAL MUX
    // --------------------------------------------------------

    assertJobActive(
      jobId
    );


    updateJob(
      jobId,
      {
        progress:
          92,

        current_step:
          'muxing_final_video'
      }
    );


    const outputPath =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );


    await muxFinal({
      jobId,

      videoPath:
        combinedVideo,

      audioPath:
        finalAudio,

      destination:
        outputPath,

      settings
    });


    assertJobActive(
      jobId
    );


    // --------------------------------------------------------
    // FINAL FILE QA
    // --------------------------------------------------------

    const stat =
      await fsp.stat(
        outputPath
      );


    if (
      stat.size <
      10000
    ) {

      throw new Error(
        `Final output is unexpectedly small: ${stat.size} bytes`
      );
    }


    const finalVideoDuration =
      await getMediaDuration(
        jobId,
        outputPath
      );


    const finalDurationDifference =
      Math.abs(
        finalVideoDuration -
        finalAudioDuration
      );


    if (
      finalDurationDifference >
      MEDIA_DURATION_TOLERANCE_SECONDS
    ) {

      throw new Error(
        [
          'Final A/V duration QA failed',
          `video=${finalVideoDuration.toFixed(3)}`,
          `audio=${finalAudioDuration.toFixed(3)}`,
          `difference=${finalDurationDifference.toFixed(3)}`
        ].join(' | ')
      );
    }


    assertJobActive(
      jobId
    );


    updateJob(
      jobId,
      {
        status:
          'completed',

        progress:
          100,

        current_step:
          'completed',

        completed_at:
          nowIso(),

        output_path:
          outputPath,

        output_size_bytes:
          stat.size,

        final_video_duration:
          Number(
            finalVideoDuration
              .toFixed(3)
          ),

        error:
          null
      }
    );


    // --------------------------------------------------------
    // CLEAN WORK DIRECTORY
    // --------------------------------------------------------

    try {

      await fsp.rm(
        workDir,
        {
          recursive:
            true,

          force:
            true
        }
      );

    } catch (_) {}


  } catch (error) {

    const job =
      jobs.get(
        jobId
      );


    // Timeout handler owns timeout state.
    if (
      job?.timeout ===
      true
    ) {

      console.error(
        `[${jobId}] Render stopped after timeout`,
        error.message
      );

      return;
    }


    updateJob(
      jobId,
      {
        status:
          'failed',

        current_step:
          'failed',

        completed_at:
          nowIso(),

        error:
          cleanText(
            error.message
          ) ||
          'Unknown render error',

        failed_scene_number:
          error.sceneNumber ??
          null,

        failed_shot_index:
          error.shotIndex ??
          null,

        failed_audio_part:
          error.partIndex ??
          null,

        failed_url:
          error.failedUrl ??
          null
      }
    );


    console.error(
      `[${jobId}] Render failed`,
      error
    );
  }
}


// ============================================================
// HARD TIMEOUT
// ============================================================

async function processRenderWithTimeout(
  jobId,
  payload
) {

  const job =
    jobs.get(
      jobId
    );

  if (!job) {
    return;
  }


  const requestedSeconds =
    safeNumber(
      payload
        ?.render_settings
        ?.hard_timeout_seconds,
      HARD_TIMEOUT_MINUTES *
      60
    );


  const timeoutSeconds =
    Math.max(
      60,
      Math.min(
        HARD_TIMEOUT_MINUTES *
        60,
        requestedSeconds
      )
    );


  let timeoutHandle;


  const timeoutPromise =
    new Promise(
      (
        _resolve,
        reject
      ) => {

        timeoutHandle =
          setTimeout(
            () => {

              const currentJob =
                jobs.get(
                  jobId
                );

              if (!currentJob) {

                reject(
                  new Error(
                    'Render job disappeared'
                  )
                );

                return;
              }


              currentJob.timeout =
                true;


              currentJob.status =
                'failed';


              currentJob.current_step =
                'timeout';


              currentJob.completed_at =
                nowIso();


              currentJob.error =
                `Render hard timeout after ${Math.round(timeoutSeconds / 60)} minutes`;


              try {

                currentJob
                  .abort_controller
                  ?.abort();

              } catch (_) {}


              killActiveChildren(
                jobId
              );


              const error =
                new Error(
                  currentJob.error
                );


              error.isTimeout =
                true;


              reject(
                error
              );

            },
            timeoutSeconds *
            1000
          );
      }
    );


  try {

    await Promise.race([

      processRender(
        jobId,
        payload
      ),

      timeoutPromise
    ]);


  } catch (error) {

    const currentJob =
      jobs.get(
        jobId
      );


    if (
      currentJob?.timeout
    ) {

      console.error(
        `[${jobId}] ${currentJob.error}`
      );

    } else {

      console.error(
        `[${jobId}] Render wrapper error`,
        error
      );
    }


  } finally {

    clearTimeout(
      timeoutHandle
    );
  }
}


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  async (
    req,
    res
  ) => {

    try {

      await ensureDirectories();


      res.json({

        ok:
          true,

        service:
          'Midnight Files Render Server',

        version:
          SERVER_VERSION,

        render_mode:
          'segment-render-concat',

        timing_mode:
          'audio-driven-scene-weighted',

        scene_weight:
          'payload.scene_timings.narration_weight',

        timing_source:
          'ffprobe narration duration + scene narration weights',

        audio_timeline:
          'opening-silence + narration + ending-silence',

        resolution_default:
          '1280x720',

        fps_default:
          24,

        scene_mode:
          'dynamic',

        min_scenes:
          MIN_SCENES,

        max_scenes:
          MAX_SCENES,

        visuals:
          'dynamic-scenes-x-2',

        shots_per_scene:
          EXPECTED_SHOTS_PER_SCENE,

        hard_timeout_minutes:
          HARD_TIMEOUT_MINUTES,

        timeout_process_kill:
          true,

        visual_render_concurrency:
          VISUAL_RENDER_CONCURRENCY,

        download_retry:
          {
            enabled:
              true,

            max_attempts:
              DOWNLOAD_MAX_ATTEMPTS
          },

        duration_qa:
          true,

        presentation_support: {

          opening_disclaimer:
            true,

          reconstruction_label:
            true,

          date_location:
            true,

          theory_disclaimer:
            true,

          ending_card:
            true
        },

        time:
          nowIso()
      });


    } catch (error) {

      res
        .status(500)
        .json({

          ok:
            false,

          error:
            error.message
        });
    }
  }
);


// ============================================================
// CREATE JOB
// ============================================================

app.post(
  '/render',
  async (
    req,
    res
  ) => {

    try {

      await ensureDirectories();


      const payload =
        req.body ??
        {};


      const scenes =
        safeArray(
          payload.scenes
        );


      const audioParts =
        safeArray(
          payload.audio_parts
        );


      // Validate before creating expensive background work.
      validateScenes(
        scenes
      );


      validateAudioParts(
        audioParts
      );


      normalizeSceneTimings({
        input:
          payload.scene_timings,

        scenes
      });


      const jobId =
        createJobId();


      const job = {

        job_id:
          jobId,

        status:
          'queued',

        progress:
          0,

        current_step:
          'queued',

        created_at:
          nowIso(),

        started_at:
          null,

        completed_at:
          null,

        total_visuals:
          scenes.length,

        total_audio_parts:
          audioParts.length,

        narration_duration:
          null,

        final_audio_duration:
          null,

        combined_video_duration:
          null,

        final_video_duration:
          null,

        opening_duration:
          null,

        ending_duration:
          null,

        scene_timeline:
          null,

        timeline_validation:
          null,

        audio_part_durations:
          null,

        output_path:
          null,

        output_size_bytes:
          null,

        error:
          null,

        failed_scene_number:
          null,

        failed_shot_index:
          null,

        failed_audio_part:
          null,

        failed_url:
          null,

        timeout:
          false,

        abort_controller:
          new AbortController(),

        active_children:
          new Set()
      };


      jobs.set(
        jobId,
        job
      );


      setImmediate(
        () => {

          processRenderWithTimeout(
            jobId,
            payload
          )
            .catch(
              error => {

                console.error(
                  `[${jobId}] Unhandled render error`,
                  error
                );
              }
            );
        }
      );


      return res
        .status(202)
        .json({

          job_id:
            jobId,

          status:
            'queued',

          status_url:
            `/status/${jobId}`,

          download_url:
            `/download/${jobId}`,

          version:
            SERVER_VERSION
        });


    } catch (error) {

      console.error(
        'POST /render error',
        error
      );


      return res
        .status(400)
        .json({

          error:
            cleanText(
              error.message
            ) ||
            'Invalid render payload',

          version:
            SERVER_VERSION
        });
    }
  }
);


// ============================================================
// STATUS
// ============================================================

app.get(
  '/status/:jobId',
  (
    req,
    res
  ) => {

    const job =
      jobs.get(
        req.params.jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({

          error:
            'Job not found'
        });
    }


    return res.json(
      publicJob(
        job
      )
    );
  }
);


// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  '/download/:jobId',
  async (
    req,
    res
  ) => {

    const job =
      jobs.get(
        req.params.jobId
      );


    if (!job) {

      return res
        .status(404)
        .json({

          error:
            'Job not found'
        });
    }


    if (
      job.status !==
      'completed'
    ) {

      return res
        .status(409)
        .json({

          error:
            'Render is not completed',

          status:
            job.status
        });
    }


    const outputPath =
      job.output_path;


    if (!outputPath) {

      return res
        .status(404)
        .json({

          error:
            'Output path missing'
        });
    }


    try {

      await fsp.access(
        outputPath
      );


    } catch (_) {

      return res
        .status(404)
        .json({

          error:
            'Output file not found'
        });
    }


    return res.download(
      outputPath,
      `midnight-files-${job.job_id}.mp4`
    );
  }
);


// ============================================================
// ROOT
// ============================================================

app.get(
  '/',
  (
    req,
    res
  ) => {

    res.json({

      service:
        'Midnight Files Render Server',

      version:
        SERVER_VERSION,

      endpoints: {

        health:
          'GET /health',

        render:
          'POST /render',

        status:
          'GET /status/:jobId',

        download:
          'GET /download/:jobId'
      }
    });
  }
);


// ============================================================
// START
// ============================================================

ensureDirectories()
  .then(
    () => {

      app.listen(
        PORT,
        '0.0.0.0',
        () => {

          console.log(
            '============================================'
          );

          console.log(
            'Midnight Files Render Server'
          );

          console.log(
            `Version: ${SERVER_VERSION}`
          );

          console.log(
            `Port: ${PORT}`
          );

          console.log(
            'Mode: segment-render-concat'
          );

          console.log(
            'Timing: ffprobe + payload scene timings'
          );

          console.log(
            `Scenes: dynamic (${MIN_SCENES}-${MAX_SCENES})`
          );

          console.log(
            'Visuals: dynamic scenes x 2 shots'
          );

          console.log(
            `Shots per scene: ${EXPECTED_SHOTS_PER_SCENE}`
          );

          console.log(
            'Audio: opening silence + narration + ending silence'
          );

          console.log(
            'Default: 1280x720 / 24fps'
          );

          console.log(
            `Hard timeout: ${HARD_TIMEOUT_MINUTES} minutes`
          );

          console.log(
            `FFmpeg timeout kill: enabled / visual concurrency: ${VISUAL_RENDER_CONCURRENCY}`
          );

          console.log(
            'Duration QA: enabled'
          );

          console.log(
            '============================================'
          );
        }
      );
    }
  )
  .catch(
    error => {

      console.error(
        'Server initialization failed',
        error
      );

      process.exit(1);
    }
  );
