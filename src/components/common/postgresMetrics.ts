import { formatDuration } from '@kinvolk/headlamp-plugin/lib/Utils';
import {
  countMetricWhere,
  formatBytes,
  maxMetric,
  metricByLabel,
  PrometheusSeries,
  scalarMetric,
  sumMetric,
} from './promScrape';

export interface PostgresMetric {
  label: string;
  category: string;
  // Reads the primary regardless of the instance selector.
  primaryOnly?: boolean;
  description: string;
  metricNames: string[];
  compute: (series: PrometheusSeries) => string;
}

export const GENERAL_HEALTH = 'General Health';
export const CHECKPOINTING = 'Checkpointing';
export const CNPG_REPLICATION = 'CNPG Replication & Archiving';

const EXPORTER_USENAME = 'cnpg_metrics_exporter';

function formatSecondsSince(seconds: number): string {
  return seconds < 0 ? 'Never' : formatDuration(seconds * 1000, { format: 'brief' });
}

export const POSTGRES_METRICS: Record<string, PostgresMetric> = {
  connectedStandbys: {
    label: 'Connected Standbys',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description: 'Number of streaming replicas currently connected to this instance.',
    metricNames: ['cnpg_pg_replication_streaming_replicas'],
    compute: series => String(scalarMetric(series, 'cnpg_pg_replication_streaming_replicas')),
  },
  replicationLag: {
    label: 'Replication Lag (Max)',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description:
      'The largest replay-lag gap, in bytes, among all connected standbys — how far behind the most-lagging replica is.',
    metricNames: ['cnpg_pg_stat_replication_replay_diff_bytes'],
    compute: series => formatBytes(maxMetric(series, 'cnpg_pg_stat_replication_replay_diff_bytes')),
  },
  inactiveReplicationSlots: {
    label: 'Inactive Replication Slots',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description:
      'Replication slots with no client connected. An inactive slot still retains WAL indefinitely, which can fill up disk if left unused.',
    metricNames: ['cnpg_pg_replication_slots_active'],
    compute: series =>
      String(countMetricWhere(series, 'cnpg_pg_replication_slots_active', value => value === 0)),
  },
  walArchivingFailures: {
    label: 'WAL Archiving Failures',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description: 'Number of failed WAL archiving attempts since statistics were last reset.',
    metricNames: ['cnpg_pg_stat_archiver_failed_count'],
    compute: series => String(scalarMetric(series, 'cnpg_pg_stat_archiver_failed_count')),
  },
  syncReplicas: {
    label: 'Sync Replicas (Observed/Expected)',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description:
      'How many synchronous standbys are currently connected, compared to how many synchronous_standby_names requires.',
    metricNames: ['cnpg_collector_sync_replicas'],
    compute: series =>
      `${metricByLabel(series, 'cnpg_collector_sync_replicas', 'value', 'observed')}/${metricByLabel(
        series,
        'cnpg_collector_sync_replicas',
        'value',
        'expected'
      )}`,
  },
  walBacklog: {
    label: 'WAL Segments Awaiting Archiving',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description:
      'WAL segments waiting to be archived. A growing number means archiving is falling behind.',
    metricNames: ['cnpg_collector_pg_wal_archive_status'],
    compute: series =>
      String(metricByLabel(series, 'cnpg_collector_pg_wal_archive_status', 'value', 'ready')),
  },
  timeSinceLastArchival: {
    label: 'Time Since Last Archival',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description: 'Time elapsed since the last successful WAL archiving operation.',
    metricNames: ['cnpg_pg_stat_archiver_seconds_since_last_archival'],
    compute: series =>
      formatSecondsSince(scalarMetric(series, 'cnpg_pg_stat_archiver_seconds_since_last_archival')),
  },
  timeSinceLastArchiveFailure: {
    label: 'Time Since Last Failure',
    category: CNPG_REPLICATION,
    primaryOnly: true,
    description:
      "Time elapsed since the last failed WAL archiving attempt, or 'Never' if none have failed.",
    metricNames: ['cnpg_pg_stat_archiver_seconds_since_last_failure'],
    compute: series =>
      formatSecondsSince(scalarMetric(series, 'cnpg_pg_stat_archiver_seconds_since_last_failure')),
  },

  activeConnections: {
    label: 'Active Connections',
    category: GENERAL_HEALTH,
    description:
      "Client backend connections, excluding replication connections and the metrics exporter's own probe connection.",
    metricNames: ['cnpg_backends_total'],
    compute: series =>
      String(
        sumMetric(series, 'cnpg_backends_total', {
          label: 'usename',
          values: ['streaming_replica', EXPORTER_USENAME],
        })
      ),
  },
  cacheHitRatio: {
    label: 'Cache Hit Ratio (%)',
    category: GENERAL_HEALTH,
    description:
      "Percentage of data blocks served from Postgres's shared buffer cache instead of disk, summed across all databases. Lower values can indicate memory pressure.",
    metricNames: ['cnpg_pg_stat_database_blks_hit', 'cnpg_pg_stat_database_blks_read'],
    compute: series => {
      const hit = sumMetric(series, 'cnpg_pg_stat_database_blks_hit');
      const read = sumMetric(series, 'cnpg_pg_stat_database_blks_read');
      return hit + read === 0 ? '0' : ((hit * 100) / (hit + read)).toFixed(2);
    },
  },
  totalDatabaseSize: {
    label: 'Total Database Size',
    category: GENERAL_HEALTH,
    description: 'Combined on-disk size of every database in the instance.',
    metricNames: ['cnpg_pg_database_size_bytes'],
    compute: series => formatBytes(sumMetric(series, 'cnpg_pg_database_size_bytes')),
  },
  blockedQueries: {
    label: 'Blocked Queries',
    category: GENERAL_HEALTH,
    description:
      'Backends currently waiting on another query (e.g. a lock conflict) — broader than strictly lock waits, but the closest default metric available.',
    metricNames: ['cnpg_backends_waiting_total'],
    compute: series => String(scalarMetric(series, 'cnpg_backends_waiting_total')),
  },
  deadlocks: {
    label: 'Deadlocks (Cumulative)',
    category: GENERAL_HEALTH,
    description: 'Total deadlocks detected across all databases since statistics were last reset.',
    metricNames: ['cnpg_pg_stat_database_deadlocks'],
    compute: series => String(sumMetric(series, 'cnpg_pg_stat_database_deadlocks')),
  },
  longestRunningTransaction: {
    label: 'Longest Running Transaction',
    category: GENERAL_HEALTH,
    description:
      'Duration of the longest-running open transaction across all backends. A long-running transaction can block autovacuum and hold back replication.',
    metricNames: ['cnpg_backends_max_tx_duration_seconds'],
    compute: series =>
      formatDuration(maxMetric(series, 'cnpg_backends_max_tx_duration_seconds') * 1000, {
        format: 'brief',
      }),
  },

  requestedCheckpoints: {
    label: 'Requested Checkpoints',
    category: CHECKPOINTING,
    description:
      'Checkpoints triggered because too much WAL accumulated, rather than on a schedule. A high count relative to scheduled checkpoints can mean max_wal_size is too small.',
    metricNames: ['cnpg_pg_stat_checkpointer_checkpoints_req'],
    compute: series => String(scalarMetric(series, 'cnpg_pg_stat_checkpointer_checkpoints_req')),
  },
  scheduledCheckpoints: {
    label: 'Scheduled Checkpoints',
    category: CHECKPOINTING,
    description: 'Checkpoints triggered on the regular checkpoint_timeout schedule.',
    metricNames: ['cnpg_pg_stat_checkpointer_checkpoints_timed'],
    compute: series => String(scalarMetric(series, 'cnpg_pg_stat_checkpointer_checkpoints_timed')),
  },
  requestedRestartpoints: {
    label: 'Requested Restartpoints',
    category: CHECKPOINTING,
    description:
      'The replica equivalent of requested checkpoints — restartpoints triggered because too much WAL accumulated during recovery.',
    metricNames: ['cnpg_pg_stat_checkpointer_restartpoints_req'],
    compute: series => String(scalarMetric(series, 'cnpg_pg_stat_checkpointer_restartpoints_req')),
  },
  scheduledRestartpoints: {
    label: 'Scheduled Restartpoints',
    category: CHECKPOINTING,
    description:
      'The replica equivalent of scheduled checkpoints — restartpoints triggered on the regular schedule during recovery.',
    metricNames: ['cnpg_pg_stat_checkpointer_restartpoints_timed'],
    compute: series =>
      String(scalarMetric(series, 'cnpg_pg_stat_checkpointer_restartpoints_timed')),
  },
  checkpointBuffersWritten: {
    label: 'Checkpoint Buffers Written',
    category: CHECKPOINTING,
    description: 'Number of buffers written out during checkpoint/restartpoint processing.',
    metricNames: ['cnpg_pg_stat_checkpointer_buffers_written'],
    compute: series => String(scalarMetric(series, 'cnpg_pg_stat_checkpointer_buffers_written')),
  },
};

// Preserves each category's first-seen order in POSTGRES_METRICS.
export function groupMetricsByCategory(
  metrics: Record<string, PostgresMetric>
): [string, [string, PostgresMetric][]][] {
  const order: string[] = [];
  const groups: Record<string, [string, PostgresMetric][]> = {};

  for (const entry of Object.entries(metrics)) {
    const [, metric] = entry;
    if (!groups[metric.category]) {
      groups[metric.category] = [];
      order.push(metric.category);
    }
    groups[metric.category].push(entry);
  }

  return order.map(category => [category, groups[category]]);
}
