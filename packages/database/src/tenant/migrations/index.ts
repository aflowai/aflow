/**
 * Ordered tenant migration registry — explicit execution order preserved.
 */
import type { TenantMigrationFn } from './types.js';
import { applyMigration001 } from './migration001.js';
import { applyMigration002 } from './migration002.js';
import { applyMigration003 } from './migration003.js';
import { applyMigration004 } from './migration004.js';
import { applyMigration005 } from './migration005.js';
import { applyMigration006 } from './migration006.js';
import { applyMigration007 } from './migration007.js';
import { applyMigration008 } from './migration008.js';
import { applyMigration010 } from './migration010.js';
import { applyMigration011 } from './migration011.js';
import { applyMigration009 } from './migration009.js';
import { applyMigration012 } from './migration012.js';
import { applyMigration013 } from './migration013.js';
import { applyMigration014 } from './migration014.js';
import { applyMigration015 } from './migration015.js';
import { applyMigration016 } from './migration016.js';
import { applyMigration017 } from './migration017.js';
import { applyMigration018 } from './migration018.js';
import { applyMigration019 } from './migration019.js';
import { applyMigration020 } from './migration020.js';
import { applyMigration021 } from './migration021.js';
import { applyMigration022 } from './migration022.js';
import { applyMigration023 } from './migration023.js';
import { applyMigration024 } from './migration024.js';
import { applyMigration025 } from './migration025.js';
import { applyMigration026 } from './migration026.js';
import { applyMigration027 } from './migration027.js';
import { applyMigration028 } from './migration028.js';
import { applyMigration029 } from './migration029.js';
import { applyMigration030 } from './migration030.js';
import { applyMigration031 } from './migration031.js';
import { applyMigration032 } from './migration032.js';
import { applyMigration033 } from './migration033.js';
import { applyMigration034 } from './migration034.js';
import { applyMigration035 } from './migration035.js';
import { applyMigration036 } from './migration036.js';
import { applyMigration037 } from './migration037.js';
import { applyMigration038 } from './migration038.js';
import { applyMigration039 } from './migration039.js';
import { applyMigration040 } from './migration040.js';
import { applyMigration042 } from './migration042.js';
import { applyMigration043 } from './migration043.js';
import { applyMigration044 } from './migration044.js';
import { applyMigration045 } from './migration045.js';
import { applyMigration046 } from './migration046.js';
import { applyMigration047 } from './migration047.js';
import { applyMigration048 } from './migration048.js';
import { applyMigration049 } from './migration049.js';
import { applyMigration050 } from './migration050.js';
import { applyMigration051 } from './migration051.js';
import { applyMigration052 } from './migration052.js';
import { applyMigration053 } from './migration053.js';
import { applyMigration054 } from './migration054.js';
import { applyMigration055 } from './migration055.js';
import { applyMigration056 } from './migration056.js';
import { applyMigration057 } from './migration057.js';
import { applyMigration058 } from './migration058.js';
import { applyMigration059 } from './migration059.js';
import { applyMigration060 } from './migration060.js';
import { applyMigration061 } from './migration061.js';
import { applyMigration062 } from './migration062.js';
import { applyMigration063 } from './migration063.js';
import { applyMigration064 } from './migration064.js';
import { applyMigration065 } from './migration065.js';
import { applyMigration066 } from './migration066.js';
import { applyMigration067 } from './migration067.js';
import { applyMigration068 } from './migration068.js';
import { applyMigration069 } from './migration069.js';
import { applyMigration070 } from './migration070.js';
import { applyMigration071 } from './migration071.js';
import { applyMigration072 } from './migration072.js';
import { applyMigration073 } from './migration073.js';
import { applyMigration074 } from './migration074.js';
import { applyMigration075 } from './migration075.js';
import { applyMigration076 } from './migration076.js';
import { applyMigration077 } from './migration077.js';
import { applyMigration078 } from './migration078.js';
import { applyMigration079 } from './migration079.js';
import { applyMigration080 } from './migration080.js';
import { applyMigration081 } from './migration081.js';
import { applyMigration082 } from './migration082.js';
import { applyMigration083 } from './migration083.js';
import { applyMigration084 } from './migration084.js';
import { applyMigration085 } from './migration085.js';
import { applyMigration086 } from './migration086.js';
import { applyMigration087 } from './migration087.js';
import { applyMigration088 } from './migration088.js';
import { applyMigration089 } from './migration089.js';
import { applyMigration090 } from './migration090.js';
import { applyMigration091 } from './migration091.js';
import { applyMigration092 } from './migration092.js';
import { applyMigration093 } from './migration093.js';
import { applyMigration094 } from './migration094.js';
import { applyMigration095 } from './migration095.js';
import { applyMigration096 } from './migration096.js';
import { applyMigration097 } from './migration097.js';
import { applyMigration098 } from './migration098.js';
import { applyMigration099 } from './migration099.js';
import { applyMigration100 } from './migration100.js';
import { applyMigration101 } from './migration101.js';
import { applyMigration102 } from './migration102.js';
import { applyMigration103 } from './migration103.js';
import { applyMigration104 } from './migration104.js';
import { applyMigration105 } from './migration105.js';
import { applyMigration106 } from './migration106.js';
import { applyMigration107 } from './migration107.js';
import { applyMigration108 } from './migration108.js';
import { applyMigration111 } from './migration111.js';
import { applyMigration112 } from './migration112.js';
import { applyMigration115 } from './migration115.js';
import { applyMigration116 } from './migration116.js';
import { applyMigration117 } from './migration117.js';
import { applyMigration118 } from './migration118.js';
import { applyMigration119 } from './migration119.js';
import { applyMigration120 } from './migration120.js';
import { applyMigration121 } from './migration121.js';
import { applyMigration122 } from './migration122.js';
import { applyMigration123 } from './migration123.js';
import { applyMigration124 } from './migration124.js';
import { applyMigration125 } from './migration125.js';
import { applyMigration126 } from './migration126.js';
import { applyMigration127 } from './migration127.js';
import { applyMigration128 } from './migration128.js';
import { applyMigration129 } from './migration129.js';
import { applyMigration130 } from './migration130.js';
import { applyMigration131 } from './migration131.js';
import { applyMigration132 } from './migration132.js';
import { applyMigration133 } from './migration133.js';
import { applyMigration134 } from './migration134.js';
import { applyMigration135 } from './migration135.js';
import { applyMigration136 } from './migration136.js';
import { applyMigration137 } from './migration137.js';
import { applyMigration138 } from './migration138.js';
import { applyMigration139 } from './migration139.js';
import { applyMigration140 } from './migration140.js';
import { applyMigration141 } from './migration141.js';
import { applyMigration142 } from './migration142.js';
import { applyMigration143 } from './migration143.js';
import { applyMigration146 } from './migration146.js';
import { applyMigration147 } from './migration147.js';
import { applyMigration148 } from './migration148.js';
import { applyMigration149 } from './migration149.js';
import { applyMigration150 } from './migration150.js';
import { applyMigration151 } from './migration151.js';
import { applyMigration152 } from './migration152.js';
import { applyMigration153 } from './migration153.js';
import { applyMigration154 } from './migration154.js';
import { applyMigration157 } from './migration157.js';
import { applyMigration158 } from './migration158.js';
import { applyMigration159 } from './migration159.js';
import { applyMigration160 } from './migration160.js';
import { applyMigration161 } from './migration161.js';
import { applyMigration162 } from './migration162.js';
import { applyMigration163 } from './migration163.js';
import { applyMigration164 } from './migration164.js';
import { applyMigration165 } from './migration165.js';
import { applyMigration166 } from './migration166.js';
import { applyMigration167 } from './migration167.js';
import { applyMigration168 } from './migration168.js';
import { applyMigration169 } from './migration169.js';
import { applyMigration170 } from './migration170.js';
import { applyMigration171 } from './migration171.js';
import { applyMigration172 } from './migration172.js';
import { applyMigration173 } from './migration173.js';
import { applyMigration174 } from './migration174.js';
import { applyMigration175 } from './migration175.js';
import { applyMigration177 } from './migration177.js';
import { applyMigration178 } from './migration178.js';
import { applyMigration179 } from './migration179.js';
import { applyMigration180 } from './migration180.js';
import { applyMigration181 } from './migration181.js';
import { applyMigration182 } from './migration182.js';
import { applyMigration183 } from './migration183.js';
import { applyMigration184 } from './migration184.js';
import { applyMigration185 } from './migration185.js';
import { applyMigration186 } from './migration186.js';
import { applyMigration187 } from './migration187.js';
import { applyMigration188 } from './migration188.js';
import { applyMigration189 } from './migration189.js';
import { applyMigration190 } from './migration190.js';
import { applyMigration191 } from './migration191.js';
import { applyMigration192 } from './migration192.js';
import { applyMigration193 } from './migration193.js';
import { applyMigration194 } from './migration194.js';
import { applyMigration195 } from './migration195.js';
import { applyMigration196 } from './migration196.js';
import { applyMigration197 } from './migration197.js';
import { applyMigration198 } from './migration198.js';
import { applyMigration199 } from './migration199.js';
import { applyMigration200 } from './migration200.js';
import { applyMigration201 } from './migration201.js';
import { applyMigration202 } from './migration202.js';
import { applyMigration203 } from './migration203.js';
import { applyMigration204 } from './migration204.js';
import { applyMigration205 } from './migration205.js';
import { applyMigration206 } from './migration206.js';
import { applyMigration207 } from './migration207.js';
import { applyMigration208 } from './migration208.js';
import { applyMigration209 } from './migration209.js';
import { applyMigration210 } from './migration210.js';
import { applyMigration211 } from './migration211.js';
import { applyMigration212 } from './migration212.js';
import { applyMigration213 } from './migration213.js';
import { applyMigration214 } from './migration214.js';
import { applyMigration215 } from './migration215.js';
import { applyMigration216 } from './migration216.js';
import { applyMigration217 } from './migration217.js';
import { applyMigration218 } from './migration218.js';

/** Migrations 1–33 — skipped when schema_migrations already records version 34. */
export const PRE_TAXONOMY_MIGRATIONS: readonly TenantMigrationFn[] = [
  applyMigration001,
  applyMigration002,
  applyMigration003,
  applyMigration004,
  applyMigration005,
  applyMigration006,
  applyMigration007,
  applyMigration008,
  applyMigration010,
  applyMigration011,
  applyMigration009,
  applyMigration012,
  applyMigration013,
  applyMigration014,
  applyMigration015,
  applyMigration016,
  applyMigration017,
  applyMigration018,
  applyMigration019,
  applyMigration020,
  applyMigration021,
  applyMigration022,
  applyMigration023,
  applyMigration024,
  applyMigration025,
  applyMigration026,
  applyMigration027,
  applyMigration028,
  applyMigration029,
  applyMigration030,
  applyMigration031,
  applyMigration032,
  applyMigration033,
];

/** Migrations 34+ — always attempted (SQL is idempotent). */
export const POST_TAXONOMY_MIGRATIONS: readonly TenantMigrationFn[] = [
  applyMigration034,
  applyMigration035,
  applyMigration036,
  applyMigration037,
  applyMigration038,
  applyMigration039,
  applyMigration040,
  applyMigration042,
  applyMigration043,
  applyMigration044,
  applyMigration045,
  applyMigration046,
  applyMigration047,
  applyMigration048,
  applyMigration049,
  applyMigration050,
  applyMigration051,
  applyMigration052,
  applyMigration053,
  applyMigration054,
  applyMigration055,
  applyMigration056,
  applyMigration057,
  applyMigration058,
  applyMigration059,
  applyMigration060,
  applyMigration061,
  applyMigration062,
  applyMigration063,
  applyMigration064,
  applyMigration065,
  applyMigration066,
  applyMigration067,
  applyMigration068,
  applyMigration069,
  applyMigration070,
  applyMigration071,
  applyMigration072,
  applyMigration073,
  applyMigration074,
  applyMigration075,
  applyMigration076,
  applyMigration077,
  applyMigration078,
  applyMigration079,
  applyMigration080,
  applyMigration081,
  applyMigration082,
  applyMigration083,
  applyMigration084,
  applyMigration085,
  applyMigration086,
  applyMigration087,
  applyMigration088,
  applyMigration089,
  applyMigration090,
  applyMigration091,
  applyMigration092,
  applyMigration093,
  applyMigration094,
  applyMigration095,
  applyMigration096,
  applyMigration097,
  applyMigration098,
  applyMigration099,
  applyMigration100,
  applyMigration101,
  applyMigration102,
  applyMigration103,
  applyMigration104,
  applyMigration105,
  applyMigration106,
  applyMigration107,
  applyMigration108,
  applyMigration111,
  applyMigration112,
  applyMigration115,
  applyMigration116,
  applyMigration117,
  applyMigration118,
  applyMigration119,
  applyMigration120,
  applyMigration121,
  applyMigration122,
  applyMigration123,
  applyMigration124,
  applyMigration125,
  applyMigration126,
  applyMigration127,
  applyMigration128,
  applyMigration129,
  applyMigration130,
  applyMigration131,
  applyMigration132,
  applyMigration133,
  applyMigration134,
  applyMigration135,
  applyMigration136,
  applyMigration137,
  applyMigration138,
  applyMigration139,
  applyMigration140,
  applyMigration141,
  applyMigration142,
  applyMigration143,
  applyMigration146,
  applyMigration147,
  applyMigration148,
  applyMigration149,
  applyMigration150,
  applyMigration151,
  applyMigration152,
  applyMigration153,
  applyMigration154,
  applyMigration157,
  applyMigration158,
  applyMigration159,
  applyMigration160,
  applyMigration161,
  applyMigration162,
  applyMigration163,
  applyMigration164,
  applyMigration165,
  applyMigration166,
  applyMigration167,
  applyMigration168,
  applyMigration169,
  applyMigration170,
  applyMigration171,
  applyMigration172,
  applyMigration173,
  applyMigration174,
  applyMigration175,
  applyMigration177,
  applyMigration178,
  applyMigration179,
  applyMigration180,
  applyMigration181,
  applyMigration182,
  applyMigration183,
  applyMigration184,
  applyMigration185,
  applyMigration186,
  applyMigration187,
  applyMigration188,
  applyMigration189,
  applyMigration190,
  applyMigration191,
  applyMigration192,
  applyMigration193,
  applyMigration194,
  applyMigration195,
  applyMigration196,
  applyMigration197,
  applyMigration198,
  applyMigration199,
  applyMigration200,
  applyMigration201,
  applyMigration202,
  applyMigration203,
  applyMigration204,
  applyMigration205,
  applyMigration206,
  applyMigration207,
  applyMigration208,
  applyMigration209,
  applyMigration210,
  applyMigration211,
  applyMigration212,
  applyMigration213,
  applyMigration214,
  applyMigration215,
  applyMigration216,
  applyMigration217,
  applyMigration218,
];

export { applyMigration001 } from './migration001.js';
export { applyMigration002 } from './migration002.js';
export { applyMigration003 } from './migration003.js';
export { applyMigration004 } from './migration004.js';
export { applyMigration005 } from './migration005.js';
export { applyMigration006 } from './migration006.js';
export { applyMigration007 } from './migration007.js';
export { applyMigration008 } from './migration008.js';
export { applyMigration010 } from './migration010.js';
export { applyMigration011 } from './migration011.js';
export { applyMigration009 } from './migration009.js';
export { applyMigration012 } from './migration012.js';
export { applyMigration013 } from './migration013.js';
export { applyMigration014 } from './migration014.js';
export { applyMigration015 } from './migration015.js';
export { applyMigration016 } from './migration016.js';
export { applyMigration017 } from './migration017.js';
export { applyMigration018 } from './migration018.js';
export { applyMigration019 } from './migration019.js';
export { applyMigration020 } from './migration020.js';
export { applyMigration021 } from './migration021.js';
export { applyMigration022 } from './migration022.js';
export { applyMigration023 } from './migration023.js';
export { applyMigration024 } from './migration024.js';
export { applyMigration025 } from './migration025.js';
export { applyMigration026 } from './migration026.js';
export { applyMigration027 } from './migration027.js';
export { applyMigration028 } from './migration028.js';
export { applyMigration029 } from './migration029.js';
export { applyMigration030 } from './migration030.js';
export { applyMigration031 } from './migration031.js';
export { applyMigration032 } from './migration032.js';
export { applyMigration033 } from './migration033.js';
export { applyMigration034 } from './migration034.js';
export { applyMigration035 } from './migration035.js';
export { applyMigration036 } from './migration036.js';
export { applyMigration037 } from './migration037.js';
export { applyMigration038 } from './migration038.js';
export { applyMigration039 } from './migration039.js';
export { applyMigration040 } from './migration040.js';
export { applyMigration042 } from './migration042.js';
export { applyMigration043 } from './migration043.js';
export { applyMigration044 } from './migration044.js';
export { applyMigration045 } from './migration045.js';
export { applyMigration046 } from './migration046.js';
export { applyMigration047 } from './migration047.js';
export { applyMigration048 } from './migration048.js';
export { applyMigration049 } from './migration049.js';
export { applyMigration050 } from './migration050.js';
export { applyMigration051 } from './migration051.js';
export { applyMigration052 } from './migration052.js';
export { applyMigration053 } from './migration053.js';
export { applyMigration054 } from './migration054.js';
export { applyMigration055 } from './migration055.js';
export { applyMigration056 } from './migration056.js';
export { applyMigration057 } from './migration057.js';
export { applyMigration058 } from './migration058.js';
export { applyMigration059 } from './migration059.js';
export { applyMigration060 } from './migration060.js';
export { applyMigration061 } from './migration061.js';
export { applyMigration062 } from './migration062.js';
export { applyMigration063 } from './migration063.js';
export { applyMigration064 } from './migration064.js';
export { applyMigration065 } from './migration065.js';
export { applyMigration066 } from './migration066.js';
export { applyMigration067 } from './migration067.js';
export { applyMigration068 } from './migration068.js';
export { applyMigration069 } from './migration069.js';
export { applyMigration070 } from './migration070.js';
export { applyMigration071 } from './migration071.js';
export { applyMigration072 } from './migration072.js';
export { applyMigration073 } from './migration073.js';
export { applyMigration074 } from './migration074.js';
export { applyMigration075 } from './migration075.js';
export { applyMigration076 } from './migration076.js';
export { applyMigration077 } from './migration077.js';
export { applyMigration078 } from './migration078.js';
export { applyMigration079 } from './migration079.js';
export { applyMigration080 } from './migration080.js';
export { applyMigration081 } from './migration081.js';
export { applyMigration082 } from './migration082.js';
export { applyMigration083 } from './migration083.js';
export { applyMigration084 } from './migration084.js';
export { applyMigration085 } from './migration085.js';
export { applyMigration086 } from './migration086.js';
export { applyMigration087 } from './migration087.js';
export { applyMigration088 } from './migration088.js';
export { applyMigration089 } from './migration089.js';
export { applyMigration090 } from './migration090.js';
export { applyMigration091 } from './migration091.js';
export { applyMigration092 } from './migration092.js';
export { applyMigration093 } from './migration093.js';
export { applyMigration094 } from './migration094.js';
export { applyMigration095 } from './migration095.js';
export { applyMigration096 } from './migration096.js';
export { applyMigration097 } from './migration097.js';
export { applyMigration098 } from './migration098.js';
export { applyMigration099 } from './migration099.js';
export { applyMigration100 } from './migration100.js';
export { applyMigration101 } from './migration101.js';
export { applyMigration102 } from './migration102.js';
export { applyMigration103 } from './migration103.js';
export { applyMigration104 } from './migration104.js';
export { applyMigration105 } from './migration105.js';
export { applyMigration106 } from './migration106.js';
export { applyMigration107 } from './migration107.js';
export { applyMigration108 } from './migration108.js';
export { applyMigration111 } from './migration111.js';
export { applyMigration112 } from './migration112.js';
export { applyMigration115 } from './migration115.js';
export { applyMigration116 } from './migration116.js';
export { applyMigration117 } from './migration117.js';
export { applyMigration118 } from './migration118.js';
export { applyMigration119 } from './migration119.js';
export { applyMigration120 } from './migration120.js';
export { applyMigration121 } from './migration121.js';
export { applyMigration122 } from './migration122.js';
export { applyMigration123 } from './migration123.js';
export { applyMigration124 } from './migration124.js';
export { applyMigration125 } from './migration125.js';
export { applyMigration126 } from './migration126.js';
export { applyMigration127 } from './migration127.js';
export { applyMigration128 } from './migration128.js';
export { applyMigration129 } from './migration129.js';
export { applyMigration130 } from './migration130.js';
export { applyMigration131 } from './migration131.js';
export { applyMigration132 } from './migration132.js';
export { applyMigration133 } from './migration133.js';
export { applyMigration134 } from './migration134.js';
export { applyMigration135 } from './migration135.js';
export { applyMigration136 } from './migration136.js';
export { applyMigration137 } from './migration137.js';
export { applyMigration138 } from './migration138.js';
export { applyMigration139 } from './migration139.js';
export { applyMigration140 } from './migration140.js';
export { applyMigration141 } from './migration141.js';
export { applyMigration142 } from './migration142.js';
export { applyMigration143 } from './migration143.js';
export { applyMigration146 } from './migration146.js';
export { applyMigration147 } from './migration147.js';
export { applyMigration148 } from './migration148.js';
export { applyMigration149 } from './migration149.js';
export { applyMigration150 } from './migration150.js';
export { applyMigration151 } from './migration151.js';
export { applyMigration152 } from './migration152.js';
export { applyMigration153 } from './migration153.js';
export { applyMigration154 } from './migration154.js';
export { applyMigration157 } from './migration157.js';
export { applyMigration158 } from './migration158.js';
export { applyMigration159 } from './migration159.js';
export { applyMigration160 } from './migration160.js';
export { applyMigration161 } from './migration161.js';
export { applyMigration162 } from './migration162.js';
export { applyMigration163 } from './migration163.js';
export { applyMigration164 } from './migration164.js';
export { applyMigration165 } from './migration165.js';
export { applyMigration166 } from './migration166.js';
export { applyMigration167 } from './migration167.js';
export { applyMigration168 } from './migration168.js';
export { applyMigration169 } from './migration169.js';
export { applyMigration170 } from './migration170.js';
export { applyMigration171 } from './migration171.js';
export { applyMigration172 } from './migration172.js';
export { applyMigration173 } from './migration173.js';
export { applyMigration174 } from './migration174.js';
export { applyMigration175 } from './migration175.js';
export { applyMigration177 } from './migration177.js';
export { applyMigration178 } from './migration178.js';
export { applyMigration179 } from './migration179.js';
export { applyMigration180 } from './migration180.js';
export { applyMigration181 } from './migration181.js';
export { applyMigration182 } from './migration182.js';
export { applyMigration183 } from './migration183.js';
export { applyMigration184 } from './migration184.js';
export { applyMigration185 } from './migration185.js';
export { applyMigration186 } from './migration186.js';
export { applyMigration187 } from './migration187.js';
export { applyMigration188 } from './migration188.js';
export { applyMigration189 } from './migration189.js';
export { applyMigration190 } from './migration190.js';
export { applyMigration191 } from './migration191.js';
export { applyMigration192 } from './migration192.js';
export { applyMigration193 } from './migration193.js';
export { applyMigration194 } from './migration194.js';
export { applyMigration195 } from './migration195.js';
export { applyMigration196 } from './migration196.js';
export { applyMigration197 } from './migration197.js';
export { applyMigration198 } from './migration198.js';
export { applyMigration199 } from './migration199.js';
export { applyMigration200 } from './migration200.js';
export { applyMigration201 } from './migration201.js';
export { applyMigration202 } from './migration202.js';
export { applyMigration203 } from './migration203.js';
export { applyMigration204 } from './migration204.js';
export { applyMigration205 } from './migration205.js';
export { applyMigration206 } from './migration206.js';
export { applyMigration207 } from './migration207.js';
export { applyMigration208 } from './migration208.js';
export { applyMigration209 } from './migration209.js';
export { applyMigration210 } from './migration210.js';
export { applyMigration211 } from './migration211.js';
export { applyMigration212 } from './migration212.js';
export { applyMigration213 } from './migration213.js';
export { applyMigration214 } from './migration214.js';
export { applyMigration215 } from './migration215.js';
export { applyMigration216 } from './migration216.js';
export { applyMigration217 } from './migration217.js';
export { applyMigration218 } from './migration218.js';
