import re

import pymysql

from database import (
    Base,
    MYSQL_DATABASE,
    MYSQL_HOST,
    MYSQL_PASSWORD,
    MYSQL_PORT,
    MYSQL_USER,
    engine,
)
import model  # noqa: F401


if __name__ == "__main__":
    if not re.fullmatch(r"[A-Za-z0-9_]+", MYSQL_DATABASE):
        raise RuntimeError("MYSQL_DATABASE contains unsupported characters")

    connection = pymysql.connect(
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        user=MYSQL_USER,
        password=MYSQL_PASSWORD,
        charset="utf8mb4",
        autocommit=True,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"CREATE DATABASE IF NOT EXISTS `{MYSQL_DATABASE}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    finally:
        connection.close()

    Base.metadata.create_all(bind=engine)
    print(f"MySQL database '{MYSQL_DATABASE}' and tables created.")
