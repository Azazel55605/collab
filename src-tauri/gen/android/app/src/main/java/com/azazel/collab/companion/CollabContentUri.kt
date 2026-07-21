package com.azazel.collab.companion

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns

class CollabContentUri {
    companion object {
        @JvmStatic
        fun displayName(context: Context, uriValue: String): String? {
            val uri = Uri.parse(uriValue)
            context.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0 && cursor.moveToFirst()) {
                    return cursor.getString(index)
                }
            }
            return uri.lastPathSegment
        }
    }
}
