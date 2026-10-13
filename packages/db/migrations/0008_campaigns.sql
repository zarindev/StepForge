CREATE TABLE `campaign_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`application_id` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`parent_id` text,
	`schedule_id` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_runs_campaign_idx` ON `campaign_runs` (`campaign_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`selection_json` text DEFAULT '{"all":true}' NOT NULL,
	`environment_ids_json` text DEFAULT '[]' NOT NULL,
	`browsers_json` text DEFAULT '["chromium"]' NOT NULL,
	`viewports_json` text DEFAULT '["desktop"]' NOT NULL,
	`options_json` text DEFAULT '{}' NOT NULL,
	`notify_channel_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_app_name_uq` ON `campaigns` (`application_id`,`name`);--> statement-breakpoint
ALTER TABLE `runs` ADD `campaign_run_id` text;--> statement-breakpoint
CREATE INDEX `runs_campaign_run_idx` ON `runs` (`campaign_run_id`);--> statement-breakpoint
ALTER TABLE `schedules` ADD `campaign_id` text REFERENCES campaigns(id);