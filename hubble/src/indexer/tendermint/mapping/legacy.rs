use itertools::Itertools;
use time::OffsetDateTime;

use crate::{
    indexer::{
        api::{BlockHash, BlockHeight, IndexerError},
        event::supported::SupportedBlockEvent,
        tendermint::block_handle::EventInFlows,
    },
    postgres::ChainId,
};

type TransactionHash = String;

/// DTO corresponding to the v2_cosmos.blocks table.
#[derive(Clone)]
pub struct PgBlock {
    pub chain_id: ChainId,
    pub hash: BlockHash,
    pub height: BlockHeight,
    pub time: OffsetDateTime,
    pub data: serde_json::Value,
}

/// DTO corresponding to the v2_cosmos.transactions table.
#[derive(Clone)]
pub struct PgTransaction {
    pub chain_id: ChainId,
    pub block_hash: BlockHash,
    pub block_height: BlockHeight,
    #[allow(dead_code)]
    pub time: OffsetDateTime,
    pub data: serde_json::Value,
    pub hash: TransactionHash,
    pub index: i32,
}

/// DTO corresponding to the v2_cosmos.events table.
#[derive(Clone)]
pub struct PgEvent {
    pub chain_id: ChainId,
    pub block_hash: BlockHash,
    pub block_height: BlockHeight,
    pub time: OffsetDateTime,
    pub data: serde_json::Value,
    pub transaction_hash: Option<TransactionHash>,
    pub transaction_index: Option<i32>,
    pub block_index: i32,
}

// provides original insert details during migration.
pub async fn insert_batch_blocks(
    blocks: impl IntoIterator<Item = PgBlock>,
) -> Result<Vec<SupportedBlockEvent>, IndexerError> {
    Ok(blocks
        .into_iter()
        .map(|b| SupportedBlockEvent::TendermintBlock {
            internal_chain_id: b.chain_id.db,
            hash: b.hash.clone(),
            data: b.data.clone(),
            height: b.height.into(),
            time: b.time,
        })
        .collect_vec())
}

// provides original insert details during migration.
pub async fn insert_batch_transactions(
    transactions: impl IntoIterator<Item = PgTransaction>,
) -> Result<Vec<SupportedBlockEvent>, IndexerError> {
    Ok(transactions
        .into_iter()
        .map(|t| SupportedBlockEvent::TendermintTransaction {
            internal_chain_id: t.chain_id.db,
            block_hash: t.block_hash.clone(),
            height: t.block_height.into(),
            hash: t.hash.clone(),
            data: t.data.clone(),
            index: t.index,
        })
        .collect_vec())
}

// provides original insert details during migration.
pub async fn insert_batch_events(
    events: impl IntoIterator<Item = EventInFlows>,
) -> Result<Vec<SupportedBlockEvent>, IndexerError> {
    #![allow(clippy::type_complexity)]
    Ok(events
        .into_iter()
        .flat_map(|e| {
            e.flows
                .iter()
                .map(|flow| SupportedBlockEvent::TendermintEvent {
                    internal_chain_id: e.event.chain_id.db,
                    block_hash: e.event.block_hash.clone(),
                    height: e.event.block_height.into(),
                    transaction_hash: e.event.transaction_hash.clone(),
                    index: e.event.block_index,
                    transaction_index: e.event.transaction_index,
                    data: e.event.data.clone(),
                    time: e.event.time,
                    flow: flow.clone(),
                })
                .collect_vec()
        })
        .collect_vec())
}
