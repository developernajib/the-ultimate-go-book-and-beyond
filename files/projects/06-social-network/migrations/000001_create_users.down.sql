-- Migration: 000001_create_users (down)

DROP TRIGGER IF EXISTS user_settings_updated_at ON user_settings;
DROP TRIGGER IF EXISTS users_updated_at ON users;
DROP FUNCTION IF EXISTS set_updated_at();
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS users;
