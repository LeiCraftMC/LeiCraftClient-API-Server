CREATE TABLE `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`title` text NOT NULL,
	`changelog` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`download_url` text,
	`pipeline_url` text,
	`error_message` text,
	`modrinth_state` text DEFAULT 'skipped' NOT NULL,
	`modrinth_url` text,
	`modrinth_error` text,
	`published_at` integer,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_version_unique` ON `releases` (`version`);--> statement-breakpoint
CREATE INDEX `releases_status_idx` ON `releases` (`status`);