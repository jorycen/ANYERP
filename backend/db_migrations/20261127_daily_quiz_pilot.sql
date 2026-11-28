CREATE TABLE IF NOT EXISTS daily_quiz_pilot_attempt (
  staff_id BIGINT NOT NULL,
  business_date DATE NOT NULL,
  quiz_version VARCHAR(64) NOT NULL,
  store_id BIGINT NULL,
  first_answers JSON NULL,
  first_score INT NULL,
  remaining_questions JSON NULL,
  retry_history JSON NULL,
  first_submitted_at DATETIME NULL,
  completed_at DATETIME NULL,
  PRIMARY KEY (staff_id, business_date, quiz_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
