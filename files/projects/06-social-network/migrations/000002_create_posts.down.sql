-- Migration: 000002_create_posts (down)

DROP TRIGGER IF EXISTS posts_updated_at ON posts;
DROP TABLE IF EXISTS post_likes;
DROP TABLE IF EXISTS posts;
