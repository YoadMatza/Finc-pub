CREATE TABLE `oauth_client` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`app` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_grant` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`app` text NOT NULL,
	`resource` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`refresh_expires_at` text NOT NULL,
	`revoked_at` text,
	`revoked_reason` text,
	`calls_day` text,
	`calls_today` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_token` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_token_token_hash_unique` ON `oauth_token` (`token_hash`);