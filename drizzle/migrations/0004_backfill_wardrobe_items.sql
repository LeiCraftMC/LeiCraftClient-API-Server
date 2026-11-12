-- Custom SQL migration file, put your code below! --
-- The wardrobe used to list every free product. Keep what users already wear: save the free
-- products equipped on their linked Minecraft accounts (exclusives they own need no row).
INSERT OR IGNORE INTO `wardrobe_items` (`user_id`, `product_id`)
SELECT `minecraft_accounts`.`user_id`, `minecraft_accounts`.`cape_product_id`
FROM `minecraft_accounts`
INNER JOIN `products` ON `products`.`id` = `minecraft_accounts`.`cape_product_id`
WHERE `minecraft_accounts`.`user_id` IS NOT NULL AND `products`.`availability` = 'free';
--> statement-breakpoint
INSERT OR IGNORE INTO `wardrobe_items` (`user_id`, `product_id`)
SELECT `minecraft_accounts`.`user_id`, `equipped_cosmetics`.`product_id`
FROM `equipped_cosmetics`
INNER JOIN `minecraft_accounts` ON `minecraft_accounts`.`id` = `equipped_cosmetics`.`minecraft_account_id`
INNER JOIN `products` ON `products`.`id` = `equipped_cosmetics`.`product_id`
WHERE `minecraft_accounts`.`user_id` IS NOT NULL AND `products`.`availability` = 'free';
