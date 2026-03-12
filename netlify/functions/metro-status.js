const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const STM_ALERTS_URL = 'https://api.stm.info/pub/od/gtfs-rt/ic/v2/serviceAlerts';

const METRO_LINES = [
  { lineId: 1, routeId: '1', lineName: 'Green Line', color: '009f4d' },
  { lineId: 2, routeId: '2', lineName: 'Orange Line', color: 'f08a24' },
  { lineId: 4, routeId: '4', lineName: 'Yellow Line', color: 'ffd200' },
  { lineId: 5, routeId: '5', lineName: 'Blue Line', color: '0079c2' }
];

const SEVERITY_RANK = {
  normal: 0,
  disrupted: 1,
  major: 2
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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function extractTranslation(text) {
  if (!text || !Array.isArray(text.translation)) {
    return '';
  }

  const english = text.translation.find((entry) => entry.language === 'en' && entry.text);
  if (english) {
    return english.text.trim();
  }

  const french = text.translation.find((entry) => entry.language === 'fr' && entry.text);
  if (french) {
    return french.text.trim();
  }

  const fallback = text.translation.find((entry) => entry.text);
  return fallback ? fallback.text.trim() : '';
}

function inferStatus(message) {
  const normalized = normalizeText(message);

  if (
    normalized.includes('interruption') ||
    normalized.includes('interrompu') ||
    normalized.includes('suspendu') ||
    normalized.includes('suspension') ||
    normalized.includes('no service') ||
    normalized.includes('service interruption') ||
    normalized.includes('service suspended')
  ) {
    return 'major';
  }

  if (
    normalized.includes('delay') ||
    normalized.includes('retard') ||
    normalized.includes('ralenti') ||
    normalized.includes('slow service') ||
    normalized.includes('service ralenti') ||
    normalized.includes('service slowdown')
  ) {
    return 'disrupted';
  }

  return 'disrupted';
}

function formatUpdatedAt(timestamp) {
  if (!timestamp) {
    return null;
  }

  return new Date(Number(timestamp) * 1000).toISOString();
}

function alertRouteIds(entity) {
  const informed = entity?.alert?.informedEntity || [];
  return informed
    .map((item) => String(item.routeId || '').trim())
    .filter(Boolean);
}

function mergeLineStatus(current, candidate) {
  if (!current) {
    return candidate;
  }

  const worse =
    SEVERITY_RANK[candidate.status] > SEVERITY_RANK[current.status] ? candidate : current;
  const messages = new Set([...(current.messages || []), ...(candidate.messages || [])].filter(Boolean));

  return {
    ...worse,
    message: worse.message || [...messages][0] || '',
    messages: [...messages].slice(0, 5),
    updatedAt: worse.updatedAt || current.updatedAt || candidate.updatedAt || null
  };
}

exports.handler = async function handler() {
  const clientId = process.env.STM_CLIENT_ID || '';

  if (!clientId) {
    return json(500, {
      error: 'Missing STM_CLIENT_ID environment variable.'
    });
  }

  try {
    const response = await fetch(STM_ALERTS_URL, {
      headers: {
        'apikey': clientId
      }
    });

    if (!response.ok) {
      const details = await response.text();
      return json(response.status, {
        error: 'STM upstream request failed.',
        status: response.status,
        details
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    const lineStatuses = Object.fromEntries(
      METRO_LINES.map((line) => [
        line.routeId,
        {
          lineId: line.lineId,
          lineName: line.lineName,
          color: line.color,
          status: 'normal',
          message: '',
          messages: [],
          updatedAt: null
        }
      ])
    );

    for (const entity of feed.entity || []) {
      const routeIds = alertRouteIds(entity).filter((routeId) => routeId in lineStatuses);
      if (!routeIds.length || !entity.alert) {
        continue;
      }

      const headerText = extractTranslation(entity.alert.headerText);
      const descriptionText = extractTranslation(entity.alert.descriptionText);
      const fullMessage = [headerText, descriptionText].filter(Boolean).join(' - ');
      const status = inferStatus(fullMessage);
      const updatedAt = formatUpdatedAt(feed.header?.timestamp);

      for (const routeId of routeIds) {
        lineStatuses[routeId] = mergeLineStatus(lineStatuses[routeId], {
          ...lineStatuses[routeId],
          status,
          message: fullMessage || '',
          messages: fullMessage ? [fullMessage] : [],
          updatedAt
        });
      }
    }

    return json(
      200,
      METRO_LINES.map((line) => lineStatuses[line.routeId])
    );
  } catch (error) {
    return json(500, {
      error: 'Unable to reach STM service.',
      details: error instanceof Error ? error.message : String(error)
    });
  }
};
