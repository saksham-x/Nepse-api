-- CreateTable
CREATE TABLE `instruments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(20) NOT NULL,
    `nepse_security_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NULL,
    `sector` VARCHAR(120) NULL,
    `instrument_type` VARCHAR(60) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `last_synced_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `instruments_symbol_key`(`symbol`),
    UNIQUE INDEX `instruments_nepse_security_id_key`(`nepse_security_id`),
    INDEX `instruments_name_idx`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_candles` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `instrument_id` INTEGER NOT NULL,
    `trade_date` DATE NOT NULL,
    `open` DECIMAL(14, 4) NOT NULL,
    `high` DECIMAL(14, 4) NOT NULL,
    `low` DECIMAL(14, 4) NOT NULL,
    `close` DECIMAL(14, 4) NOT NULL,
    `volume` BIGINT UNSIGNED NOT NULL,
    `trades` INTEGER UNSIGNED NULL,
    `is_provisional` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('NEPSE', 'CSV_IMPORT') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `daily_candles_instrument_id_trade_date_key`(`instrument_id`, `trade_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quotes` (
    `instrument_id` INTEGER NOT NULL,
    `business_date` DATE NOT NULL,
    `last_traded_price` DECIMAL(14, 4) NOT NULL,
    `previous_close` DECIMAL(14, 4) NULL,
    `total_traded_qty` BIGINT UNSIGNED NULL,
    `total_trades` INTEGER UNSIGNED NULL,
    `fifty_two_week_high` DECIMAL(14, 4) NULL,
    `fifty_two_week_low` DECIMAL(14, 4) NULL,
    `source_updated_at` DATETIME(3) NULL,
    `market_open` BOOLEAN NOT NULL,
    `fetched_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`instrument_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ingestion_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('SYNC', 'BACKFILL') NOT NULL,
    `status` ENUM('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED') NOT NULL,
    `params` JSON NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `heartbeat_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `requested` INTEGER NOT NULL DEFAULT 0,
    `processed` INTEGER NOT NULL DEFAULT 0,
    `inserted` INTEGER NOT NULL DEFAULT 0,
    `updated` INTEGER NOT NULL DEFAULT 0,
    `unchanged` INTEGER NOT NULL DEFAULT 0,
    `skipped` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,
    `details` JSON NULL,

    INDEX `ingestion_runs_type_status_finished_at_idx`(`type`, `status`, `finished_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ingestion_locks` (
    `name` VARCHAR(50) NOT NULL,
    `owner` VARCHAR(64) NOT NULL,
    `acquired_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `daily_candles` ADD CONSTRAINT `daily_candles_instrument_id_fkey` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `quotes` ADD CONSTRAINT `quotes_instrument_id_fkey` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

