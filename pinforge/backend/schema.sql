-- backend/schema.sql — optional MySQL tables for the PinForge backend.
-- v1 only uses usage_log. The other tables are ready for the future
-- Pinterest API / multi-user version (see docs/FUTURE_PINTEREST_API.md).

CREATE TABLE IF NOT EXISTS usage_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ip_hash     CHAR(64)     NOT NULL,
  model       VARCHAR(80)  NOT NULL,
  http_status SMALLINT     NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(190) NOT NULL UNIQUE,
  token_hash  CHAR(64)     NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pinterest_accounts (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           INT UNSIGNED NOT NULL,
  pinterest_user    VARCHAR(120) NOT NULL,
  access_token_enc  TEXT         NOT NULL,  -- encrypt with sodium_crypto_secretbox before storing
  refresh_token_enc TEXT         NOT NULL,
  expires_at        DATETIME     NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS published_pins (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  pinterest_pin VARCHAR(64)  NULL,
  board_id      VARCHAR(64)  NOT NULL,
  title         VARCHAR(100) NOT NULL,
  link          VARCHAR(2048) NULL,
  status        ENUM('queued','published','failed') NOT NULL DEFAULT 'queued',
  error         VARCHAR(500) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
