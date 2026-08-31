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
  'midnight-files-render-v2.0.0';

const HARD_TIMEOUT_MINUTES = 35;
const HARD_TIMEOUT_MS =
  HARD_TIMEOUT_MINUTES * 60 * 1000;

const ROOT_DIR =
  path.join(
    os.tmpdir(),
    'midnight-files-render'
  );

const JOBS_DIR =
  path.join(ROOT_DIR, 'jobs');

const OUTPUT_DIR =
  path.join(ROOT_DIR, 'outputs');

const jobs = new Map();

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

  return String(value).trim();
}

function safeNumber(value, fallback) {
  const n = Number(value);

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
  return new Date().toISOString();
}

function createJobId() {
  return crypto.randomUUID();
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
    { recursive: true }
  );

  await fsp.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  );
}

// ============================================================
// JOB
// ============================================================

function publicJob(job) {
  if (!job) {
    return null;
  }

  return {
    job_id: job.job_id,
    status: job.status,
    progress: job.progress,
    current_step: job.current_step,

    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,

    elapsed_seconds:
      job.started_at
        ? Math.floor(
            (
              Date.now() -
              new Date(
                job.started_at
              ).getTime()
            ) / 1000
          )
        : 0,

    total_visuals:
      job.total_visuals,

    total_audio_parts:
      job.total_audio_parts,

    narration_duration:
      job.narration_duration ?? null,

    final_audio_duration:
      job.final_audio_duration ?? null,

    opening_duration:
      job.opening_duration ?? null,

    ending_duration:
      job.ending_duration ?? null,

    scene_timeline:
      job.scene_timeline ?? null,

    output_size_bytes:
      job.output_size_bytes ?? null,

    error:
      job.error ?? null,

    failed_scene_number:
      job.failed_scene_number ?? null,

    failed_shot_index:
      job.failed_shot_index ?? null,

    failed_audio_part:
      job.failed_audio_part ?? null,

    failed_url:
      job.failed_url ?? null,

    timeout:
      job.timeout ?? false,

    max_render_minutes:
      HARD_TIMEOUT_MINUTES,

    download_url:
      job.status === 'completed'
        ? `/download/${job.job_id}`
        : null
  };
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  Object.assign(job, patch);
}

// ============================================================
// PROCESS
// ============================================================

function runProcess(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {

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

      let stdout = '';
      let stderr = '';

      child.stdout.on(
        'data',
        chunk => {
          stdout += chunk.toString();

          if (stdout.length > 20000) {
            stdout =
              stdout.slice(-20000);
          }
        }
      );

      child.stderr.on(
        'data',
        chunk => {
          stderr += chunk.toString();

          if (stderr.length > 30000) {
            stderr =
              stderr.slice(-30000);
          }
        }
      );

      child.on(
        'error',
        reject
      );

      child.on(
        'close',
        code => {

          if (code === 0) {
            resolve({
              stdout,
              stderr
            });

            return;
          }

          reject(
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

async function downloadFile({
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

  let response;

  try {

    response =
      await fetch(
        cleanUrl,
        {
          redirect: 'follow',

          headers: {
            'User-Agent':
              'Midnight-Files-Render/2.0'
          }
        }
      );

  } catch (error) {

    const wrapped =
      new Error(
        `${type} download network error: ${error.message}`
      );

    wrapped.failedUrl =
      cleanUrl;

    wrapped.sceneNumber =
      sceneNumber;

    wrapped.shotIndex =
      shotIndex;

    wrapped.partIndex =
      partIndex;

    throw wrapped;
  }

  if (!response.ok) {

    const wrapped =
      new Error(
        `${type} download failed: HTTP ${response.status} ${response.statusText}`
      );

    wrapped.failedUrl =
      cleanUrl;

    wrapped.sceneNumber =
      sceneNumber;

    wrapped.shotIndex =
      shotIndex;

    wrapped.partIndex =
      partIndex;

    throw wrapped;
  }

  const contentType =
    cleanText(
      response.headers.get(
        'content-type'
      )
    ).toLowerCase();

  if (
    contentType.includes(
      'text/html'
    )
  ) {

    const wrapped =
      new Error(
        `${type} download returned HTML instead of media. Check Google Drive sharing permission.`
      );

    wrapped.failedUrl =
      cleanUrl;

    wrapped.sceneNumber =
      sceneNumber;

    wrapped.shotIndex =
      shotIndex;

    wrapped.partIndex =
      partIndex;

    throw wrapped;
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (buffer.length < 100) {

    const wrapped =
      new Error(
        `${type} download file is unexpectedly small (${buffer.length} bytes)`
      );

    wrapped.failedUrl =
      cleanUrl;

    wrapped.sceneNumber =
      sceneNumber;

    wrapped.shotIndex =
      shotIndex;

    wrapped.partIndex =
      partIndex;

    throw wrapped;
  }

  await fsp.writeFile(
    destination,
    buffer
  );

  return {
    bytes: buffer.length,
    content_type: contentType
  };
}

// ============================================================
// FFPROBE
// ============================================================

async function getMediaDuration(
  filePath
) {

  const result =
    await runProcess(
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
    !Number.isFinite(duration) ||
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
    process.env.CJK_FONT_PATH,

    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',

    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',

    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',

    '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',

    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  ].filter(Boolean);

  for (
    const candidate of candidates
  ) {

    try {

      await fsp.access(candidate);

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
    escapeDrawtext(text);

  if (!value) {
    return '';
  }

  const args = [
    'drawtext=',
    `fontfile='${fontFile}'`,
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

function normalizeRenderSettings(input) {

  const source =
    safeObject(input);

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
      )
      ||
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
      )
      ||
      'audio_driven_scene_weighted',

    minimum_shot_duration:
      Math.max(
        2.5,
        safeNumber(
          source.minimum_shot_duration,
          3.5
        )
      ),

    maximum_shot_duration:
      Math.max(
        10,
        safeNumber(
          source.maximum_shot_duration,
          30
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
    safeObject(input);

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
        )
        ||
        cleanText(
          project.opening_disclaimer
        )
        ||
        '本集內容根據公開案件資料整理',

      line_2:
        cleanText(
          opening.line_2
        )
        ||
        cleanText(
          project.reconstruction_disclaimer
        )
        ||
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
        )
        ||
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
        )
        ||
        '官方調查推測',

      default_disclaimer:
        cleanText(
          theory.default_disclaimer
        )
        ||
        '以下為官方調查認為最可能的事故解釋，並非目擊證實的完整經過'
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
        )
        ||
        cleanText(
          project.ending_title
        )
        ||
        'FLANNAN ISLES',

      subtitle:
        cleanText(
          ending.subtitle
        )
        ||
        cleanText(
          project.ending_subtitle
        )
        ||
        '1900',

      footer:
        cleanText(
          ending.footer
        )
        ||
        cleanText(
          project.ending_footer
        )
        ||
        '三名燈塔守衛失蹤，確切經過至今無法直接證實'
    }
  };
}

// ============================================================
// BUILD SCENE TIMELINE
// ============================================================

function buildSceneTimeline({
  scenes,
  narrationDuration,
  settings
}) {

  const sceneMap =
    new Map();

  for (
    const visual of scenes
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
      !sceneMap.has(
        sceneNumber
      )
    ) {

      sceneMap.set(
        sceneNumber,
        {
          scene_number:
            sceneNumber,

          narration:
            cleanText(
              visual.narration
            ),

          visuals: []
        }
      );
    }

    sceneMap
      .get(sceneNumber)
      .visuals
      .push(visual);
  }

  const storyScenes =
    [...sceneMap.values()]
      .sort(
        (a, b) =>
          a.scene_number -
          b.scene_number
      );

  if (!storyScenes.length) {
    throw new Error(
      'Unable to build scene timeline'
    );
  }

  const totalWeight =
    storyScenes.reduce(
      (sum, scene) =>
        sum +
        Math.max(
          1,
          scene.narration.length
        ),
      0
    );

  let allocated = 0;

  const timeline =
    storyScenes.map(
      (scene, index) => {

        let sceneDuration;

        if (
          index ===
          storyScenes.length - 1
        ) {

          sceneDuration =
            Math.max(
              0.1,
              narrationDuration -
              allocated
            );

        } else {

          sceneDuration =
            narrationDuration *
            (
              Math.max(
                1,
                scene.narration.length
              ) /
              totalWeight
            );

          allocated +=
            sceneDuration;
        }

        const shotCount =
          Math.max(
            1,
            scene.visuals.length
          );

        const shotDuration =
          sceneDuration /
          shotCount;

        return {
          scene_number:
            scene.scene_number,

          narration_chars:
            scene.narration.length,

          duration:
            sceneDuration,

          shot_count:
            shotCount,

          shot_duration:
            shotDuration
        };
      }
    );

  const calculatedTotal =
    timeline.reduce(
      (sum, scene) =>
        sum +
        scene.duration,
      0
    );

  const difference =
    narrationDuration -
    calculatedTotal;

  if (
    timeline.length &&
    Math.abs(difference) >
      0.0001
  ) {
    timeline[
      timeline.length - 1
    ].duration +=
      difference;

    timeline[
      timeline.length - 1
    ].shot_duration =
      timeline[
        timeline.length - 1
      ].duration /
      timeline[
        timeline.length - 1
      ].shot_count;
  }

  return timeline;
}

// ============================================================
// SILENCE
// ============================================================

async function createSilence({
  destination,
  duration,
  settings
}) {

  if (duration <= 0) {
    return;
  }

  await runProcess(
    'ffmpeg',
    [
      '-y',

      '-f',
      'lavfi',

      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',

      '-t',
      String(duration),

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
  } = settings;

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
          height * 0.047
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
          height * 0.033
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

      destination
    ]
  );
}

// ============================================================
// ENDING CARD
// ============================================================

async function createEndingCard({
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
  } = settings;

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
          height * 0.075
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
          height * 0.045
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
          height * 0.031
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

      destination
    ]
  );
}

// ============================================================
// VISUAL SEGMENT
// ============================================================

async function createVisualSegment({
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
  } = settings;

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
      Math.ceil(
        duration * fps
      )
    );

  filters.push(
    `zoompan=z='min(zoom+0.00008,1.035)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`
  );

  // ----------------------------------------------------------
  // AI reconstruction
  // ----------------------------------------------------------

  if (
    presentationSettings
      .reconstruction_overlay
      .enabled
    &&
    p.reconstruction !== false
  ) {

    const label =
      cleanText(
        p.reconstruction_label
      )
      ||
      cleanText(
        visual.reconstruction_label
      )
      ||
      presentationSettings
        .reconstruction_overlay
        .text;

    filters.push(
      drawTextFilter({
        text: label,
        fontFile,

        fontSize:
          Math.round(
            height * 0.026
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
  // Date / Location
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
            )
            ||
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
            )
            ||
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
      `between(t,0,${maxDuration})`;

    if (date) {

      filters.push(
        drawTextFilter({
          text: date,
          fontFile,

          fontSize:
            Math.round(
              height * 0.041
            ),

          x: '28',
          y: 'h-112',

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
          text: location,
          fontFile,

          fontSize:
            Math.round(
              height * 0.028
            ),

          x: '28',
          y: 'h-60',

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
  // Theory
  // ----------------------------------------------------------

  const sceneType =
    cleanText(
      p.scene_type
    )
    ||
    cleanText(
      visual.scene_type
    );

  const theoryLabel =
    cleanText(
      p.theory_label
    )
    ||
    cleanText(
      visual.theory_label
    );

  if (
    presentationSettings
      .theory_overlay
      .enabled
    &&
    (
      sceneType === 'theory'
      ||
      theoryLabel
    )
  ) {

    const theoryTitle =
      theoryLabel
      ||
      presentationSettings
        .theory_overlay
        .default_title;

    const theoryDisclaimer =
      cleanText(
        p.disclaimer
      )
      ||
      cleanText(
        visual.disclaimer
      )
      ||
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
            height * 0.035
          ),

        x: '28',
        y: '28',

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
            height * 0.026
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
    'ffmpeg',
    [
      '-y',

      '-loop',
      '1',

      '-i',
      imagePath,

      '-t',
      String(duration),

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

  } catch (_) {}

  await runProcess(
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

      destination
    ]
  );
}

// ============================================================
// CONCAT AUDIO
// ============================================================

async function concatAudio({
  files,
  destination,
  workDir,
  settings
}) {

  const concatFile =
    path.join(
      workDir,
      'audio_concat.txt'
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

  await runProcess(
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
}

// ============================================================
// FINAL AUDIO
// ============================================================

async function buildFinalAudioTimeline({
  narrationPath,
  openingDuration,
  endingDuration,
  destination,
  workDir,
  settings
}) {

  const parts = [];

  if (openingDuration > 0) {

    const openingSilence =
      path.join(
        workDir,
        'opening_silence.m4a'
      );

    await createSilence({
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

  if (endingDuration > 0) {

    const endingSilence =
      path.join(
        workDir,
        'ending_silence.m4a'
      );

    await createSilence({
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
    files: parts,
    destination,
    workDir,
    settings
  });
}

// ============================================================
// FINAL MUX
// ============================================================

async function muxFinal({
  videoPath,
  audioPath,
  destination,
  settings
}) {

  await runProcess(
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

      '-shortest',

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

    updateJob(
      jobId,
      {
        status: 'processing',
        started_at: nowIso(),
        progress: 1,
        current_step: 'initializing'
      }
    );

    await Promise.all([
      fsp.mkdir(
        imageDir,
        { recursive: true }
      ),

      fsp.mkdir(
        audioDir,
        { recursive: true }
      ),

      fsp.mkdir(
        segmentDir,
        { recursive: true }
      )
    ]);

    const scenes =
      safeArray(
        payload.scenes
      )
        .slice()
        .sort(
          (a, b) =>
            safeNumber(
              a.render_index,
              0
            )
            -
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
          (a, b) =>
            safeNumber(
              a.part_index,
              0
            )
            -
            safeNumber(
              b.part_index,
              0
            )
        );

    if (!scenes.length) {
      throw new Error(
        'Payload contains no scenes'
      );
    }

    if (!audioParts.length) {
      throw new Error(
        'Payload contains no audio_parts'
      );
    }

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
        progress: 2,
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

    const imagePaths = [];

    for (
      let index = 0;
      index < scenes.length;
      index++
    ) {

      const visual =
        scenes[index] ?? {};

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

      if (!imageUrl) {

        const error =
          new Error(
            `Scene ${sceneNumber} Shot ${shotIndex} missing image_url`
          );

        error.sceneNumber =
          sceneNumber;

        error.shotIndex =
          shotIndex;

        throw error;
      }

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
                ) * 15
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
    // AUDIO
    // --------------------------------------------------------

    const audioPaths = [];
    const audioPartDurations = [];

    for (
      let index = 0;
      index < audioParts.length;
      index++
    ) {

      const part =
        audioParts[index] ?? {};

      const partIndex =
        safeNumber(
          part.part_index,
          index + 1
        );

      const audioUrl =
        cleanText(
          part.audio_url
        );

      if (!audioUrl) {

        const error =
          new Error(
            `Audio Part ${partIndex} missing audio_url`
          );

        error.partIndex =
          partIndex;

        throw error;
      }

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
                ) * 5
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
        url:
          audioUrl,

        destination,

        type:
          'audio',

        partIndex
      });

      const duration =
        await getMediaDuration(
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

    // --------------------------------------------------------
    // CONCAT NARRATION
    // --------------------------------------------------------

    updateJob(
      jobId,
      {
        progress: 25,
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
      files:
        audioPaths,

      destination:
        narrationAudio,

      workDir,

      settings
    });

    const narrationDuration =
      await getMediaDuration(
        narrationAudio
      );

    updateJob(
      jobId,
      {
        narration_duration:
          Number(
            narrationDuration.toFixed(3)
          )
      }
    );

    // --------------------------------------------------------
    // BUILD SCENE TIMELINE
    // --------------------------------------------------------

    updateJob(
      jobId,
      {
        progress: 26,
        current_step:
          'building_scene_timeline'
      }
    );

    const sceneTimeline =
      buildSceneTimeline({
        scenes,
        narrationDuration,
        settings
      });

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

              duration:
                Number(
                  item.duration.toFixed(3)
                ),

              shot_count:
                item.shot_count,

              shot_duration:
                Number(
                  item.shot_duration.toFixed(3)
                )
            })
          )
      }
    );

    // --------------------------------------------------------
    // FINAL AUDIO
    // --------------------------------------------------------

    updateJob(
      jobId,
      {
        progress: 27,
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
        finalAudio
      );

    updateJob(
      jobId,
      {
        final_audio_duration:
          Number(
            finalAudioDuration.toFixed(3)
          )
      }
    );

    const videoSegments = [];

    // --------------------------------------------------------
    // OPENING
    // --------------------------------------------------------

    if (
      presentation
        .opening_disclaimer
        .enabled
    ) {

      updateJob(
        jobId,
        {
          progress: 29,
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

    for (
      let index = 0;
      index < scenes.length;
      index++
    ) {

      const visual =
        scenes[index] ?? {};

      const sceneNumber =
        safeNumber(
          visual.scene_number,
          null
        );

      const timeline =
        sceneTimeline.find(
          item =>
            item.scene_number ===
            sceneNumber
        );

      if (!timeline) {

        const error =
          new Error(
            `No timeline found for Scene ${sceneNumber}`
          );

        error.sceneNumber =
          sceneNumber;

        throw error;
      }

      let duration =
        timeline.shot_duration;

      duration =
        Math.max(
          settings.minimum_shot_duration,
          Math.min(
            settings.maximum_shot_duration,
            duration
          )
        );

      updateJob(
        jobId,
        {
          progress:
            Math.min(
              82,
              30 +
              Math.floor(
                (
                  index /
                  scenes.length
                ) * 52
              )
            ),

          current_step:
            `rendering_visual_${index + 1}_of_${scenes.length}`
        }
      );

      const segmentPath =
        path.join(
          segmentDir,
          `segment_${String(index + 1).padStart(3, '0')}.mp4`
        );

      await createVisualSegment({
        imagePath:
          imagePaths[index],

        destination:
          segmentPath,

        duration,

        visual,

        settings,

        presentationSettings:
          presentation,

        fontFile
      });

      videoSegments.push(
        segmentPath
      );
    }

    // --------------------------------------------------------
    // ENDING
    // --------------------------------------------------------

    if (
      presentation
        .ending_card
        .enabled
    ) {

      updateJob(
        jobId,
        {
          progress: 84,
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

    updateJob(
      jobId,
      {
        progress: 87,
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
      files:
        videoSegments,

      destination:
        combinedVideo,

      workDir,

      settings
    });

    // --------------------------------------------------------
    // FINAL MUX
    // --------------------------------------------------------

    updateJob(
      jobId,
      {
        progress: 92,
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
      videoPath:
        combinedVideo,

      audioPath:
        finalAudio,

      destination:
        outputPath,

      settings
    });

    const stat =
      await fsp.stat(
        outputPath
      );

    if (stat.size < 10000) {
      throw new Error(
        `Final output is unexpectedly small: ${stat.size} bytes`
      );
    }

    updateJob(
      jobId,
      {
        status: 'completed',
        progress: 100,
        current_step: 'completed',
        completed_at: nowIso(),
        output_path: outputPath,
        output_size_bytes: stat.size,
        error: null
      }
    );

    try {

      await fsp.rm(
        workDir,
        {
          recursive: true,
          force: true
        }
      );

    } catch (_) {}

  } catch (error) {

    updateJob(
      jobId,
      {
        status: 'failed',
        current_step: 'failed',
        completed_at: nowIso(),

        error:
          cleanText(
            error.message
          )
          ||
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

  let timeoutHandle;

  const timeoutPromise =
    new Promise(
      (_resolve, reject) => {

        timeoutHandle =
          setTimeout(
            () => {

              const error =
                new Error(
                  `Render hard timeout after ${HARD_TIMEOUT_MINUTES} minutes`
                );

              error.isTimeout =
                true;

              reject(error);

            },
            HARD_TIMEOUT_MS
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

    updateJob(
      jobId,
      {
        status: 'failed',
        current_step: 'failed',
        completed_at: nowIso(),

        error:
          cleanText(
            error.message
          ),

        timeout: true
      }
    );

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
        ok: true,

        service:
          'Midnight Files Render Server',

        version:
          SERVER_VERSION,

        render_mode:
          'segment-render-concat',

        timing_mode:
          'audio-driven-scene-weighted',

        scene_weight:
          'narration-character-count',

        audio_timeline:
          'opening-silence + narration + ending-silence',

        resolution_default:
          '1280x720',

        fps_default:
          24,

        hard_timeout_minutes:
          HARD_TIMEOUT_MINUTES,

        presentation_support: {
          opening_disclaimer: true,
          reconstruction_label: true,
          date_location: true,
          theory_disclaimer: true,
          ending_card: true
        },

        time:
          nowIso()
      });

    } catch (error) {

      res
        .status(500)
        .json({
          ok: false,
          error: error.message
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
        req.body ?? {};

      const scenes =
        safeArray(
          payload.scenes
        );

      const audioParts =
        safeArray(
          payload.audio_parts
        );

      if (!scenes.length) {
        return res
          .status(400)
          .json({
            error:
              'scenes is required'
          });
      }

      if (!audioParts.length) {
        return res
          .status(400)
          .json({
            error:
              'audio_parts is required'
          });
      }

      const jobId =
        createJobId();

      const job = {
        job_id: jobId,

        status: 'queued',
        progress: 0,
        current_step: 'queued',

        created_at: nowIso(),
        started_at: null,
        completed_at: null,

        total_visuals:
          scenes.length,

        total_audio_parts:
          audioParts.length,

        narration_duration: null,
        final_audio_duration: null,

        opening_duration: null,
        ending_duration: null,

        scene_timeline: null,

        output_path: null,
        output_size_bytes: null,

        error: null,

        failed_scene_number: null,
        failed_shot_index: null,
        failed_audio_part: null,
        failed_url: null,

        timeout: false
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
          ).catch(
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
          job_id: jobId,
          status: 'queued',

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
        .status(500)
        .json({
          error:
            error.message
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
      publicJob(job)
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
            'Timing: audio-driven-scene-weighted'
          );

          console.log(
            'Scene weight: narration character count'
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
