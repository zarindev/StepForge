ALTER TABLE `runs` ADD `schedule_id` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `options_json` text DEFAULT '{}' NOT NULL;