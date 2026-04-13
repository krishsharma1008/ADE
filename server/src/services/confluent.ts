import type { ConfluentConfig, ConfluentTopic, ConfluentProduceResult } from "@combyne/shared";

/**
 * Confluent Cloud REST API client.
 * Uses the Confluent Kafka REST API v3 for topic management and the
 * REST Proxy for produce/consume operations.
 */
export function createConfluentClient(config: ConfluentConfig) {
  const authHeader =
    "Basic " + Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64");

  const kafkaBaseUrl = `https://${config.bootstrapServer}/kafka/v3/clusters/${config.cluster}`;

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Confluent API error ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as T;
  }

  return {
    /** Test connectivity by fetching cluster metadata. */
    async testConnection(): Promise<{ ok: boolean; clusterId?: string; error?: string }> {
      try {
        const info = await request<{ cluster_id?: string }>(kafkaBaseUrl);
        return { ok: true, clusterId: info.cluster_id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    /** List topics in the cluster. */
    async listTopics(): Promise<ConfluentTopic[]> {
      const data = await request<{
        data: Array<{
          topic_name: string;
          partitions_count: number;
          replication_factor: number;
        }>;
      }>(`${kafkaBaseUrl}/topics`);
      return data.data.map((t) => ({
        name: t.topic_name,
        partitions: t.partitions_count,
        replicationFactor: t.replication_factor,
      }));
    },

    /** Create a topic. */
    async createTopic(
      name: string,
      partitions = 1,
      replicationFactor = 3,
    ): Promise<ConfluentTopic> {
      await request(`${kafkaBaseUrl}/topics`, {
        method: "POST",
        body: JSON.stringify({
          topic_name: name,
          partitions_count: partitions,
          replication_factor: replicationFactor,
        }),
      });
      return { name, partitions, replicationFactor };
    },

    /** Delete a topic by name. */
    async deleteTopic(name: string): Promise<void> {
      await request(`${kafkaBaseUrl}/topics/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    },

    /** Produce a record to a topic using the Confluent REST Proxy. */
    async produce(
      topic: string,
      value: Record<string, unknown>,
      key?: string,
    ): Promise<ConfluentProduceResult> {
      const restProxyUrl = `https://${config.bootstrapServer}/kafka/v3/clusters/${config.cluster}/topics/${encodeURIComponent(topic)}/records`;
      const payload: Record<string, unknown> = {
        value: { type: "JSON", data: value },
      };
      if (key) {
        payload.key = { type: "STRING", data: key };
      }
      const result = await request<{
        topic_name: string;
        partition_id: number;
        offset: number;
      }>(restProxyUrl, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return {
        topic: result.topic_name,
        partition: result.partition_id,
        offset: result.offset,
      };
    },

    /**
     * Publish a Combyne platform event to a topic.
     * Wraps the event with metadata (source, timestamp, company context).
     */
    async publishEvent(
      topic: string,
      eventType: string,
      companyId: string,
      payload: Record<string, unknown>,
    ): Promise<ConfluentProduceResult> {
      const envelope = {
        source: "combyne",
        eventType,
        companyId,
        timestamp: new Date().toISOString(),
        data: payload,
      };
      return this.produce(topic, envelope, `${companyId}:${eventType}`);
    },
  };
}
