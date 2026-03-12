const STM_BASE_URL = 'https://api.stm.info/pub/od/i3/v2/messages/etatservice';

const LINE_ALIASES = {
  '1': '1',
  green: '1',
  verte: '1',
  'ligne verte': '1',
  'green line': '1',
  '2': '2',
  orange: '2',
  'ligne orange': '2',
  'orange line': '2',
  '4': '4',
  yellow: '4',
  jaune: '4',
  'ligne jaune': '4',
  'yellow line': '4',
  '5': '5',
  blue: '5',
  bleue: '5',
  'ligne bleue': '5',
  'blue line': '5'
};

const LINE_INFO = {
  '1': { lineId: '1', lineName: 'Green Line', color: '#009f4d' },
  '2': { lineId: '2', lineName: 'Orange Line', color: '#f08a24' },
  '4': { lineId: '4', lineName: 'Yellow Line', color: '#ffd200' },
  '5': { lineId: '5', lineName: 'Blue Line', color: '#0079c2' }
};

const SEVERITY_RANK = {
  normal: 0,
  advisory: 1,
  disrupted: 2,
  major: 3
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, stale-while-revalidate=120'
    },
    body: JSON.stringify(body)
  };
}

function normalizeString(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function pickFirstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function flattenObjects(value, bucket = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenObjects(item, bucket));
    return bucket;
  }

  if (value && typeof value === 'object') {
    bucket.push(value);
    Object.values(value).forEach((child) => flattenObjects(child, bucket));
  }

  return bucket;
}

function normalizeLineId(rawValue) {
  const normalized = normalizeString(rawValue);
  if (!normalized) {
    return null;
  }

  if (LINE_ALIASES[normalized]) {
    return LINE_ALIASES[normalized];
  }

  const digitMatch = normalized.match(/\b([1245])\b/);
  if (digitMatch) {
    return digitMatch[1];
  }

  return null;
}

function inferStatus(text) {
  const normalized = normalizeString(text);
  if (!normalized) {
    return 'advisory';
  }

  if (
    normalized.includes('service normal') ||
    normalized.includes('normal service') ||
    normalized.includes('reprise du service')
  ) {
    return 'normal';
  }

  if (
    normalized.includes('interruption') ||
    normalized.includes('interrompu') ||
    normalized.includes('suspendu') ||
    normalized.includes('suspension') ||
    normalized.includes('no service') ||
    normalized.includes('service interruption')
  ) {
    return 'major';
  }

  if (
    normalized.includes('ralenti') ||
    normalized.includes('delay') ||
    normalized.includes('retard') ||
    normalized.includes('perturb') ||
    normalized.includes('slow') ||
    normalized.includes('entrave')
  ) {
    return 'disrupted';
  }

  return 'advisory';
}

function mergeStatus(current, candidate) {
  if (!current) {
    return candidate;
  }

  const next =
    SEVERITY_RANK[candidate.status] > SEVERITY_RANK[current.status]
      ? { ...current, ...candidate }
      : { ...candidate, ...current };

  const messages = new Set([...(current.messages || []), ...(candidate.messages || [])].filter(Boolean));
  return {
    ...next,
    messages: [...messages].slice(0, 3),
    message: [...messages][0] || ''
  };
}

function extractCandidate(object) {
  const possibleLineValue =
    object.line ??
    object.lineId ??
    object.line_id ??
    object.route ??
    object.routeId ??
    object.route_id ??
    object.ligne ??
    object.idLigne ??
    object.codeLigne ??
    object.noLigne ??
    object.couleur ??
    object.metroLine ??
    object.nomLigne;

  const lineId = normalizeLineId(possibleLineValue);
  if (!lineId) {
    return null;
  }

  const message = pickFirstString(object, [
    'message',
    'description',
    'titre',
    'title',
    'texte',
    'text',
    'detail',
    'details'
  ]);

  const rawStatus = pickFirstString(object, ['status', 'etat', 'state', 'severity', 'impact']);
  const status = rawStatus ? inferStatus(rawStatus + ' ' + message) : inferStatus(message);
  const updatedAt = pickFirstString(object, [
    'updatedAt',
    'updated_at',
    'dateMaj',
    'dateMiseAJour',
    'timestamp',
    'date',
    'debut',
    'startDate'
  ]);

  return {
    lineId,
    status,
    updatedAt,
    messages: message ? [message] : [],
    message: message || ''
  };
}

function normalizeMetroStatuses(payload) {
  const normalized = {};
  const candidates = flattenObjects(payload).map(extractCandidate).filter(Boolean);

  candidates.forEach((candidate) => {
    normalized[candidate.lineId] = mergeStatus(normalized[candidate.lineId], candidate);
  });

  return Object.values(LINE_INFO).map((line) => {
    const live = normalized[line.lineId];
    return {
      ...line,
      status: live?.status || 'normal',
      message: live?.message || '',
      messages: live?.messages || [],
      updatedAt: live?.updatedAt || null
    };
  });
}

exports.handler = async function handler() {
  const clientId = process.env.STM_CLIENT_ID || '';
  const clientSecret = process.env.STM_CLIENT_SECRET || '';
  const apiKey = process.env.STM_CLIENT_ID

  if (!apiKey || !clientSecret) {
    return json(500, {
      error: 'Missing STM_API_KEY/STM_CLIENT_ID or STM_CLIENT_SECRET environment variable.'
    });
  }

  try {
    const response = await fetch(STM_BASE_URL, {
      headers: {
        Accept: 'application/json',
        'X-IBM-Client-Id': apiKey,
        'X-IBM-Client-Secret': clientSecret
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return json(response.status, {
        error: 'STM upstream request failed.',
        status: response.status,
        details: errorText
      });
    }

    const payload = await response.json();
    return json(200, normalizeMetroStatuses(payload));
  } catch (error) {
    return json(500, {
      error: 'Unable to reach STM service.',
      details: error instanceof Error ? error.message : String(error)
    });
  }
};
