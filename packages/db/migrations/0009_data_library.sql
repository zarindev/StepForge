ALTER TABLE `datasets` ADD `kind` text DEFAULT 'table' NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` ADD `config_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `datasets_app_name_uq` ON `datasets` (`application_id`,`name`);