-- 杯身上的字：由用户在自己账号里设置，默认为空，也就是杯子上不显示任何字。
-- length() 对文本按字符（码点）计数，emoji 也算一个字符。
ALTER TABLE members ADD COLUMN cup_mark TEXT CHECK (cup_mark IS NULL OR length(cup_mark) = 1);
