CREATE TABLE `market_data_cache` (
	`source` text NOT NULL,
	`key` text NOT NULL,
	`fetched_at` text NOT NULL,
	`json` text NOT NULL,
	PRIMARY KEY(`source`, `key`)
);
